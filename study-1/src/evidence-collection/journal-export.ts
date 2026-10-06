// Journal exports (design §5.3 `exportJournal`, §7, §9.3). A journal table partition holds the
// events of several sources: the caller journal holds the caller events and, for the canary, the
// runner's inserted timeout (D-10); the experiment journal holds the provider's and the
// controller's events. Each export reads the whole partition with strongly consistent pages and
// writes one JSONL file per evidence owner, in the store's sort-key order
// `<source>#<source_instance_id>#<source_sequence:12>`, so each instance's events are contiguous
// and in sequence order (BR-RUA-033).
//
// An item is routed by the source its sort key names. Caller state items (`state#attempt#…`,
// `state#request#…`) are caller state, never events, and stay out of every journal. Any other item
// whose key names no source of the plan fails the whole export: a journal that silently left an
// item out would look complete to ingestion, while an absent journal is ARTIFACT_MISSING and makes
// the gates that need it unverified (fail closed, design §8.2 I1).

import type { StoredItem } from '../durable-store/item-store-port.ts';
import type { JournalTableRole } from '../event-journal/journal-entry.ts';
import type { EventSource } from '../record-contract/envelope.ts';
import { boundedJsonText, boundedText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { JsonObject, Result, StructuredReason } from '../record-contract/primitives.ts';
import { encodeRecordLines, readWholePartition, recordOfItem } from './collected-records.ts';
import type { CollectorStoreReader } from './collected-records.ts';

/**
 * The journal files a collection writes, named by their design §7 layout keys (the
 * `UNIT_PATHS` and `EXECUTION_PATHS` keys of evidence-package).
 */
export type CollectedJournalFile =
  | 'callerJournal'
  | 'providerJournal'
  | 'controllerJournal'
  | 'canaryCallerJournal'
  | 'canaryControllerJournal'
  | 'warmupProviderJournal'
  | 'executionProviderJournal';

/** One output file and the event sources whose items it holds. */
export interface JournalRoute {
  readonly file: CollectedJournalFile;
  readonly sources: readonly EventSource[];
}

/** One partition of one journal table and how its items split into files. */
export interface JournalExportPlan {
  readonly table: JournalTableRole;
  readonly partition_key: string;
  readonly routes: readonly JournalRoute[];
}

/** One exported journal: its events in order and their JSONL bytes. */
export interface JournalFileExport {
  readonly file: CollectedJournalFile;
  readonly events: readonly JsonObject[];
  readonly bytes: Uint8Array;
}

/** The sort-key prefix of caller state items, which are not journal events (design §9.3). */
export const CALLER_STATE_SORT_KEY_PREFIX = 'state#';

/** The caller sources of a trial or probe partition of the caller journal. */
export const CALLER_SOURCES: readonly EventSource[] = ['conventional_caller', 'durable_caller', 'probe_caller'];

/**
 * The two exports of a trial or probe partition: the caller journal, then the provider and
 * controller halves of the experiment journal (design §7 `journals/`).
 *
 * @example
 * unitJournalPlans(`${runId}#${trialId}`).map((plan) => plan.table); // ['caller_journal', 'experiment_journal']
 */
export function unitJournalPlans(partitionKey: string): readonly JournalExportPlan[] {
  return [
    {
      table: 'caller_journal',
      partition_key: partitionKey,
      routes: [{ file: 'callerJournal', sources: CALLER_SOURCES }],
    },
    {
      table: 'experiment_journal',
      partition_key: partitionKey,
      routes: [
        { file: 'providerJournal', sources: ['refund_provider'] },
        { file: 'controllerJournal', sources: ['treatment_controller'] },
      ],
    },
  ];
}

/**
 * Exports one partition into its files, in route order. Every route yields a file, empty when no
 * event belongs to it (an empty journal is valid evidence, design §8.1).
 *
 * @example
 * const exported = await exportJournals(store, unitJournalPlans(pk)[1]);
 * if (exported.ok) exported.value.map((file) => file.file); // ['providerJournal', 'controllerJournal']
 */
export async function exportJournals(
  reader: CollectorStoreReader,
  plan: JournalExportPlan,
): Promise<Result<readonly JournalFileExport[], StructuredReason>> {
  const read = await readWholePartition(reader, plan.table, plan.partition_key);
  if (!read.ok) {
    return read;
  }
  const routed = routeJournalItems(read.value.items, plan);
  if (!routed.ok) {
    return routed;
  }
  const files: JournalFileExport[] = [];
  for (const bucket of routed.value) {
    const bytes = encodeRecordLines(bucket.events, bucket.file);
    if (!bytes.ok) {
      return bytes;
    }
    files.push({ file: bucket.file, events: bucket.events, bytes: bytes.value });
  }
  return ok(files);
}

/** The events routed to one file, in partition order. */
export interface JournalBucket {
  readonly file: CollectedJournalFile;
  readonly sources: readonly EventSource[];
  readonly events: JsonObject[];
}

/**
 * Splits a partition's items into the plan's files, one bucket per route in route order, by the
 * source each sort key names; caller state items are skipped and an item no route claims is
 * refused.
 *
 * @example
 * routeJournalItems(items, plan).ok; // false when an item's key names no planned source
 */
export function routeJournalItems(
  items: readonly StoredItem[],
  plan: JournalExportPlan,
): Result<readonly JournalBucket[], StructuredReason> {
  const buckets: JournalBucket[] = plan.routes.map((route) => ({
    file: route.file,
    sources: route.sources,
    events: [],
  }));
  for (const item of items) {
    if (isCallerState(plan, item)) {
      continue;
    }
    const bucket = bucketOf(buckets, item.sk);
    if (bucket === undefined) {
      return err(unroutable(plan, item.sk));
    }
    bucket.events.push(recordOfItem(item));
  }
  return ok(buckets);
}

function isCallerState(plan: JournalExportPlan, item: StoredItem): boolean {
  return plan.table === 'caller_journal' && item.sk.startsWith(CALLER_STATE_SORT_KEY_PREFIX);
}

// A key without a separator yields the whole key, which names no source and so no bucket.
function bucketOf(buckets: readonly JournalBucket[], sortKey: string): JournalBucket | undefined {
  const separator = sortKey.indexOf('#');
  const source = sortKey.slice(0, separator === -1 ? sortKey.length : separator);
  return buckets.find((bucket) => (bucket.sources as readonly string[]).includes(source));
}

function unroutable(plan: JournalExportPlan, sortKey: string): StructuredReason {
  const expected = plan.routes.flatMap((route) => route.sources).join(', ');
  return {
    code: 'JOURNAL_ITEM_UNROUTABLE',
    subject: 'BR-RUA-033',
    detail: `${plan.table} partition ${boundedText(plan.partition_key)} holds an item with sort key ${boundedJsonText(sortKey)}; expected <source>#<instance>#<sequence> with a source in ${expected}`,
  };
}
