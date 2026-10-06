// Shared mechanics of every collector: turning a stored item back into its record, reading a whole
// strongly consistent partition, encoding records as evidence bytes, and the structured reason a
// failed read produces. Store items and SDK outputs are untrusted input (Owner amendment A-05), so
// these helpers read only own members, encode through the kernel's total canonical writer and
// report a value JSON cannot hold instead of throwing.

import type { DurableItemStore, StoredItem, TableRole } from '../durable-store/item-store-port.ts';
import { canonicalJsonIfRepresentable } from '../record-contract/canonical-json.ts';
import { boundedText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { JsonObject, JsonValue, Result, StructuredReason } from '../record-contract/primitives.ts';

/** The strongly consistent reads every collector uses: the DurableItemStore read methods (design §9.3). */
export type CollectorStoreReader = Pick<DurableItemStore, 'getConsistent' | 'queryPartitionPage'>;

/** Why a port read did not return data (an SDK error name or a local decoding code). */
export interface CollectorReadFailure {
  readonly code: string;
}

/** Every item of one partition, in the store's ascending sort-key order. */
export interface PartitionRead {
  readonly items: readonly StoredItem[];
  readonly page_count: number;
}

const encoder = new TextEncoder();

/**
 * The record an item holds: the item without its table key (`pk`, `sk`), which is storage
 * addressing and never part of the record (design §9.3).
 *
 * @example
 * recordOfItem({ pk: 'r#t', sk: 'config', record_type: 'provider_trial_configuration' }); // { record_type: ... }
 */
export function recordOfItem(item: StoredItem): JsonObject {
  const { pk: _pk, sk: _sk, ...record } = item;
  return record;
}

/**
 * Reads every page of a partition with strongly consistent reads, until the store returns no
 * cursor (the only proof of completeness). A failed page or a cursor the store already returned
 * (which would loop forever) ends the read with a reason instead.
 *
 * @example
 * const read = await readWholePartition(store, 'experiment_journal', `${runId}#${trialId}`);
 * if (read.ok) read.value.items.length;
 */
export async function readWholePartition(
  reader: CollectorStoreReader,
  table: TableRole,
  partitionKey: string,
): Promise<Result<PartitionRead, StructuredReason>> {
  const items: StoredItem[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;
  for (;;) {
    pageCount += 1;
    const page = await reader.queryPartitionPage(table, partitionKey, cursor);
    if (!page.ok) {
      return err(readFailure('PARTITION_READ_FAILED', table, partitionKey, page.error, pageCount));
    }
    appendEach(items, page.value.items);
    cursor = page.value.next_cursor;
    if (cursor === undefined) {
      return ok({ items, page_count: pageCount });
    }
    if (seen.has(cursor)) {
      return err(repeatedCursor(table, partitionKey, pageCount));
    }
    seen.add(cursor);
  }
}

/**
 * Appends every element of `source` to `target`, one push each: a spread push of a huge page
 * exceeds the engine's argument limit and throws RangeError (A-05).
 *
 * @example
 * appendEach(items, page.value.items);
 */
export function appendEach<T>(target: T[], source: readonly T[]): void {
  for (const element of source) {
    target.push(element);
  }
}

/**
 * The evidence bytes of one record file: canonical JSON and one newline, UTF-8 (BR-RUA-033). A
 * record JSON cannot represent exactly (a non-finite number, a non-plain value) is refused.
 *
 * @example
 * const bytes = encodeRecordFile(snapshot, 'ledger_snapshot');
 */
export function encodeRecordFile(record: JsonValue, subject: string): Result<Uint8Array, StructuredReason> {
  const text = canonicalJsonIfRepresentable(record);
  return text === undefined ? err(unrepresentable(subject, 'record')) : ok(encoder.encode(`${text}\n`));
}

/**
 * The evidence bytes of a JSONL file: one canonical record per line, each ending with a newline;
 * zero records encode to zero bytes (BR-RUA-033).
 *
 * @example
 * const bytes = encodeRecordLines(events, 'caller_journal');
 */
export function encodeRecordLines(
  records: readonly JsonValue[],
  subject: string,
): Result<Uint8Array, StructuredReason> {
  const lines: string[] = [];
  for (const [index, record] of records.entries()) {
    const text = canonicalJsonIfRepresentable(record);
    if (text === undefined) {
      return err(unrepresentable(subject, `line ${String(index + 1)}`));
    }
    lines.push(`${text}\n`);
  }
  return ok(encoder.encode(lines.join('')));
}

/**
 * The reason a port read failed, naming what was read and the failure code.
 *
 * @example
 * readFailure('LEDGER_READ_FAILED', 'ledger', pk, { code: 'ProvisionedThroughputExceededException' }, 2);
 */
export function readFailure(
  code: string,
  subject: string,
  target: string,
  failure: CollectorReadFailure,
  pageNumber?: number,
): StructuredReason {
  const page = pageNumber === undefined ? '' : ` at page ${String(pageNumber)}`;
  return {
    code,
    subject: 'BR-RUA-037',
    detail: `${subject} read of ${boundedText(target)}${page} failed with ${boundedText(failure.code)}; expected a successful strongly consistent read`,
  };
}

function repeatedCursor(table: TableRole, partitionKey: string, pageCount: number): StructuredReason {
  return {
    code: 'PARTITION_CURSOR_REPEATED',
    subject: 'BR-RUA-037',
    detail: `${table} partition ${boundedText(partitionKey)} returned an already-seen cursor after page ${String(pageCount)}; expected each page to advance until no cursor remains`,
  };
}

function unrepresentable(subject: string, where: string): StructuredReason {
  return {
    code: 'RECORD_NOT_REPRESENTABLE',
    subject: 'BR-RUA-033',
    detail: `${subject} ${where} holds a value JSON cannot represent exactly (a non-finite number or a non-plain value); expected a JSON record`,
  };
}
