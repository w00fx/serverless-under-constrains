// The probe evidence directory of an offline transport rehearsal (design §7 "A probe package
// replaces trials/ with a single probe/ directory", §12.3). It holds what the collector would read
// after the probe: the probe partition's caller, provider and controller journals, the
// configuration, payment and treatment state, and the strongly consistent ledger snapshot. Every
// record is checked against its catalogue schema before anything is written.
//
// PROVISIONAL LAYOUT. This is a subset of the §7 probe layout, not a package: it has no
// `probe/inputs/approved-decision.json`, no `settlement/` and no `derived/`, and its `readiness/`
// paths are invented here. The package layout and its collection belong to WP-13 (evidence
// package) and WP-25 (evidence collection); the readiness phase that writes the canary and the
// warm-up belongs to WP-26. In particular the rehearsal canary cites runner-generated
// predecessor ids (its `causation_event_ids` and `monotonic_origin_event_id`, which the
// `caller_timeout_recorded` schema requires) that no exported event carries, because D-10 does
// not say which runner event the canary follows. The `readiness/` files therefore do not resolve
// under BR-RUA-034 and must not be read as package evidence until WP-26 defines that predecessor.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { StoredItem } from '../../../src/durable-store/item-store-port.ts';
import type { JournalEvent } from '../../../src/event-journal/journal-event.ts';
import { serializeJsonl, serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import type { StudyRecord } from '../../../src/record-contract/records/index.ts';
import type { RecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { formatUtcMillis } from '../../../src/record-contract/timestamps.ts';
import { MANIFEST_SHA, PAYMENT_ID, PROBE_ID, PROBE_PK } from '../refund-provider/provider-fixtures.ts';
import { CANARY_PK, WARMUP_PK } from './transport-rehearsal.ts';
import type { TransportRehearsal } from './transport-rehearsal.ts';

/** One evidence file: a single record (`.json`) or a record list (`.jsonl`). */
export type EvidenceFile =
  | { readonly kind: 'record'; readonly record: JsonObject }
  | { readonly kind: 'jsonl'; readonly records: readonly JsonObject[] };

/** Package-relative POSIX path → content. */
export type ProbeEvidence = ReadonlyMap<string, EvidenceFile>;

const PROBE_SCOPE = { transport_probe_id: PROBE_ID, execution_manifest_sha256: MANIFEST_SHA } as const;

/**
 * Collects the probe evidence of a rehearsal that has quiesced.
 *
 * @example
 * const evidence = collectProbeEvidence(rehearsal);
 * evidence.get('probe/journals/controller-journal.jsonl');
 */
export function collectProbeEvidence(rehearsal: TransportRehearsal): ProbeEvidence {
  const experiment = rehearsal.events('experiment_journal', PROBE_PK);
  const capturedAt = formatUtcMillis(rehearsal.time.now());
  return new Map<string, EvidenceFile>([
    ['probe/journals/caller-journal.jsonl', jsonl(rehearsal.events('caller_journal', PROBE_PK))],
    ['probe/journals/provider-journal.jsonl', jsonl(experiment.filter((event) => event.source === 'refund_provider'))],
    [
      'probe/journals/controller-journal.jsonl',
      jsonl(experiment.filter((event) => event.source === 'treatment_controller')),
    ],
    ['probe/state/provider-trial-configuration.json', record(withoutKey(controlItem(rehearsal, 'config')))],
    ['probe/inputs/payment.json', record(withoutKey(controlItem(rehearsal, `payment#${PAYMENT_ID}`)))],
    ['probe/state/treatment-state-snapshot.json', record(treatmentSnapshot(rehearsal, capturedAt))],
    ['probe/ledger/ledger-snapshot.json', record(ledgerSnapshot(rehearsal, capturedAt))],
    ['readiness/canary-caller-journal.jsonl', jsonl(rehearsal.events('caller_journal', CANARY_PK))],
    ['readiness/canary-controller-journal.jsonl', jsonl(rehearsal.events('experiment_journal', CANARY_PK))],
    ['readiness/warmup-provider-journal.jsonl', jsonl(rehearsal.events('experiment_journal', WARMUP_PK))],
  ]);
}

/**
 * Every schema violation in the evidence, as `<path>: <record_type> <violations>`; empty when all
 * records are valid.
 *
 * @example
 * assert.deepEqual(evidenceViolations(evidence, createRecordValidator()), []);
 */
export function evidenceViolations(evidence: ProbeEvidence, validator: RecordValidator): readonly string[] {
  return [...evidence].flatMap(([path, file]) =>
    recordsOf(file).flatMap((entry) => {
      const checked = validator.validate(entry);
      return checked.valid
        ? []
        : [`${path}: ${JSON.stringify(entry['record_type'])} ${JSON.stringify(checked.violations)}`];
    }),
  );
}

/**
 * Writes the evidence under `root` as canonical JSON and JSONL bytes; returns the written paths.
 *
 * @example
 * writeProbeEvidence(mkdtempSync(join(tmpdir(), 'rehearsal-')), evidence);
 */
export function writeProbeEvidence(root: string, evidence: ProbeEvidence): readonly string[] {
  return [...evidence].map(([path, file]) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      file.kind === 'record'
        ? serializeRecordFile(file.record as unknown as StudyRecord)
        : serializeJsonl(file.records as unknown as readonly StudyRecord[]),
    );
    return path;
  });
}

/** The records of one evidence file. */
export function recordsOf(file: EvidenceFile): readonly JsonObject[] {
  return file.kind === 'record' ? [file.record] : file.records;
}

function treatmentSnapshot(rehearsal: TransportRehearsal, capturedAt: string): JsonObject {
  const treatment = rehearsal.treatment();
  const base = {
    schema_version: 1,
    record_type: 'treatment_state_snapshot',
    ...PROBE_SCOPE,
    partition_key: PROBE_PK,
    captured_at: capturedAt,
    consistent_read: true,
  };
  return treatment === undefined
    ? { ...base, item_present: false }
    : { ...base, item_present: true, treatment: withoutKey(treatment) };
}

function ledgerSnapshot(rehearsal: TransportRehearsal, capturedAt: string): JsonObject {
  const transactions = rehearsal.store
    .itemsIn('ledger')
    .filter((item) => item.pk === PROBE_PK)
    .map(withoutKey);
  return {
    schema_version: 1,
    record_type: 'ledger_snapshot',
    ...PROBE_SCOPE,
    writer: 'evidence_collector',
    partition_key: PROBE_PK,
    consistent_read: true,
    captured_at: capturedAt,
    complete: true,
    pages: [{ page_number: 1, item_count: transactions.length }],
    transactions,
  };
}

function controlItem(rehearsal: TransportRehearsal, sk: string): StoredItem {
  const item = rehearsal.store.peek('control', { pk: PROBE_PK, sk });
  if (item === undefined) {
    throw new Error(`control item ${PROBE_PK}/${sk} is absent; expected the runner to have seeded it`);
  }
  return item;
}

function withoutKey(item: StoredItem): JsonObject {
  const { pk: _pk, sk: _sk, ...attributes } = item;
  return attributes;
}

function record(value: JsonObject): EvidenceFile {
  return { kind: 'record', record: value };
}

function jsonl(events: readonly JournalEvent[]): EvidenceFile {
  return { kind: 'jsonl', records: events as unknown as readonly JsonObject[] };
}
