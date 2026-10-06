// Shared values of the trial-execution unit tests: a run, its manifest digest, a warm-up request
// and the completion the provider returns for it, and quiet settlement samples.

import type { JsonObject, Sha256Hex, UtcMillis, Uuid4 } from '../../../../src/record-contract/primitives.ts';
import type { ProviderWarmupRequest } from '../../../../src/record-contract/records/group-b/provider_warmup_request.ts';
import type { SettlementSample } from '../../../../src/settlement/settlement-policy.ts';

export const RUN_ID = '3f1c2a9e-8b4d-4c1e-9f00-1a2b3c4d5e6f' as Uuid4;
export const MANIFEST_SHA = 'a'.repeat(64) as Sha256Hex;
export const WARMUP_ID = '0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a4b' as Uuid4;
export const TRIAL_ID = '11111111-2222-4333-8444-555555555555' as Uuid4;
export const PUBLISHED_AT = '2026-10-05T12:05:00.000Z' as UtcMillis;

/** The warm-up request of the run's trial. */
export function warmupRequest(): ProviderWarmupRequest {
  return {
    schema_version: 1,
    record_type: 'provider_warmup_request',
    run_id: RUN_ID,
    execution_manifest_sha256: MANIFEST_SHA,
    warmup_id: WARMUP_ID,
    trial_id: TRIAL_ID,
  };
}

/** The provider's `provider_warmup_completed` for `warmupRequest()`. */
export function warmupCompleted(overrides: JsonObject = {}): JsonObject {
  return {
    schema_version: 1,
    record_type: 'provider_warmup_completed',
    event_id: '22222222-3333-4444-8555-666666666666',
    run_id: RUN_ID,
    execution_manifest_sha256: MANIFEST_SHA,
    occurred_at: '2026-10-05T12:04:58.000Z',
    source: 'refund_provider',
    source_instance_id: '33333333-4444-4555-8666-777777777777',
    source_sequence: 1,
    provider_call_id: '44444444-5555-4666-8777-888888888888',
    warmup_id: WARMUP_ID,
    received_at: '2026-10-05T12:04:58.000Z',
    completed_at: '2026-10-05T12:04:58.000Z',
    handler_elapsed_ns: '1000',
    ...overrides,
  };
}

/** A quiet observation sample `offsetMs` after `PUBLISHED_AT`. */
export function quietSample(offsetMs: number, overrides: Partial<SettlementSample> = {}): SettlementSample {
  return {
    observed_at: new Date(Date.parse(PUBLISHED_AT) + offsetMs).toISOString() as UtcMillis,
    phase: 'observation',
    publication_stopped: true,
    processing_terminal: true,
    inner_executions_terminal: 'not_applicable',
    provider_active_calls: 0,
    provider_held_barriers: 0,
    provider_pending_releases: 0,
    treatment_terminal: 'not_applicable',
    ledger_snapshot_possible: true,
    source_queue: { visible: 0, in_flight: 0, delayed: 0 },
    dlq: { visible: 0, in_flight: 0, delayed: 0 },
    correlated_dlq_message_ids: [],
    dlq_captured_message_ids: [],
    correlated_event_watermark: 4,
    ledger_item_count: 1,
    ...overrides,
  };
}
