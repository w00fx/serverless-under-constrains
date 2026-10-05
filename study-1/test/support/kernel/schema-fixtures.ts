// Paths of the kernel's fixture schema catalogue and well-formed sample records for it. The
// fixture schemas exercise the shared `$defs`; they are not the catalogue schemas WP-01..03 own.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import { DEFAULT_SCHEMA_ROOT } from '../../../src/record-contract/schema-registry.ts';

export const FIXTURE_CATALOGUE_ROOT = fileURLToPath(new URL('./schema-fixtures/catalogue/', import.meta.url));
export const SHARED_DEFS_PATH = join(DEFAULT_SCHEMA_ROOT, '_defs.schema.json');

export const SAMPLE_UUIDS = {
  payment: '3f1c2a9e-8b4d-4c1e-9f00-1a2b3c4d5e6f',
  event: '00000000-0000-4000-8000-000000000001',
  run: '00000000-0000-4000-8000-000000000002',
  instance: '00000000-0000-4000-8000-000000000003',
  attempt: '00000000-0000-4000-8000-000000000004',
  trial: '00000000-0000-4000-8000-000000000005',
  causeA: '00000000-0000-4000-8000-00000000000a',
  causeB: '00000000-0000-4000-8000-00000000000b',
} as const;

/** A `payment` record valid against the fixture schema. */
export function samplePayment(): JsonObject {
  return {
    schema_version: 1,
    record_type: 'payment',
    payment_id: SAMPLE_UUIDS.payment,
    captured_amount_minor: 10000,
    refunded_total_minor: '0',
    captured_at: '2026-10-05T12:00:00.000Z',
    currency: 'BRL',
  };
}

/** A `dispatch_started` journal event valid against the fixture schema and the envelope. */
export function sampleDispatchStarted(): JsonObject {
  return {
    schema_version: 1,
    record_type: 'dispatch_started',
    event_id: SAMPLE_UUIDS.event,
    run_id: SAMPLE_UUIDS.run,
    execution_manifest_sha256: 'a'.repeat(64),
    occurred_at: '2026-10-05T12:00:00.123Z',
    source: 'conventional_caller',
    source_instance_id: SAMPLE_UUIDS.instance,
    source_sequence: 1,
    attempt_id: SAMPLE_UUIDS.attempt,
  };
}

/** An `oracle_result` record valid against the fixture schema. */
export function sampleOracleResult(): JsonObject {
  return {
    schema_version: 1,
    record_type: 'oracle_result',
    result: 'pass',
    evidence_refs: [
      { artifact_path: 'journal/events.jsonl', artifact_sha256: 'b'.repeat(64), event_id: SAMPLE_UUIDS.event },
      { artifact_path: 'ledger/ledger-snapshot.json', artifact_sha256: 'c'.repeat(64), json_pointer: '/entries/0' },
    ],
    reasons: [],
  };
}
