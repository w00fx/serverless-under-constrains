// The inputs every admitted execution declares verbatim from the spec: the OR-RUA-001 financial
// fixture, the OR-RUA-002 timing and retry inputs, the provider warm-up policy (addendum §2), the
// CA-1 clock assumption, and the BR-RUA-007 declared variant differences. They are constants of
// the committed source, so a changed value is a scoped source change that a recomputed transport
// scope snapshot detects (BR-RUA-028).

import type { ExecutionKind, JsonObject } from '../record-contract/primitives.ts';
import { CA_1_SCOPE, CA_1_STATEMENT } from '../record-contract/records/group-a/execution_manifest.ts';
import type {
  ClockAssumptionDeclaration,
  DeclaredTiming,
  DeclaredVariantDifference,
} from '../record-contract/records/group-a/execution_manifest.ts';
import type {
  ProviderWarmupPolicy,
  ScopeTimingValues,
} from '../record-contract/records/group-a/transport_scope_snapshot.ts';

/** OR-RUA-001: the payment record of every trial (CTR-RUA-005). */
export const OR_RUA_001_PAYMENT: JsonObject = {
  schema_version: 1,
  record_type: 'payment',
  payment_id: 'pay-poc-001',
  captured_amount_minor: 10000,
  currency: 'BRL',
};

/** OR-RUA-001: the approved refund decision of every trial (CTR-RUA-006). */
export const OR_RUA_001_APPROVED_DECISION: JsonObject = {
  schema_version: 1,
  record_type: 'approved_decision',
  refund_request_id: 'ref-poc-001',
  payment_id: 'pay-poc-001',
  decision: 'APPROVED',
  approved_amount_minor: 10000,
  currency: 'BRL',
};

/** OR-RUA-002: every duration in milliseconds, no jitter. */
export const OR_RUA_002_TIMING: DeclaredTiming = {
  provider_client_deadline_ms: 3_000,
  provider_safety_release_ms: 15_000,
  provider_execution_timeout_ms: 30_000,
  conventional_invocation_timeout_ms: 10_000,
  durable_invocation_timeout_ms: 10_000,
  conventional_visibility_timeout_ms: 60_000,
  durable_visibility_timeout_ms: 360_000,
  durable_retry_delay_ms: 60_000,
  durable_total_step_attempts: 2,
  durable_execution_timeout_ms: 300_000,
  max_receive_count: 2,
  observation_deadline_ms: 600_000,
  stabilization_interval_ms: 120_000,
  queue_poll_interval_ms: 30_000,
  treatment_poll_interval_ms: 250,
  retry_jitter: 'NONE',
};

/** Addendum §2: the provider is warmed exactly once before each trial's publication. */
export const PROVIDER_WARMUP_POLICY: ProviderWarmupPolicy = { invocations_per_trial: 1 };

/** CA-1, declared verbatim as a study assumption that no service guarantees. */
export const CA_1_DECLARATION: ClockAssumptionDeclaration = {
  assumption_id: 'CA-1',
  assumption_type: 'clock_alignment',
  scope: CA_1_SCOPE,
  statement: CA_1_STATEMENT,
  status: 'declared_not_service_guaranteed',
};

/**
 * BR-RUA-007: the one configuration difference that is part of the variants' declared execution
 * strategies. Only a run deploys both variants, so only a run declares a difference.
 */
const RUN_VARIANT_DIFFERENCES: readonly DeclaredVariantDifference[] = [
  {
    parameter: 'source_visibility_timeout_ms',
    conventional: OR_RUA_002_TIMING.conventional_visibility_timeout_ms,
    durable: OR_RUA_002_TIMING.durable_visibility_timeout_ms,
    basis: 'BR-RUA-020: the Durable source stays invisible throughout its longer execution',
  },
];

/**
 * The declared variant differences of an execution kind.
 *
 * @example
 * declaredVariantDifferences('RUN')[0]?.durable; // 360000
 * declaredVariantDifferences('TRANSPORT_PROBE'); // []
 */
export function declaredVariantDifferences(kind: ExecutionKind): readonly DeclaredVariantDifference[] {
  return kind === 'RUN' ? RUN_VARIANT_DIFFERENCES : [];
}

/**
 * The transport timing values a scope snapshot binds (BR-RUA-028).
 *
 * @example
 * scopeTimingOf(OR_RUA_002_TIMING).treatment_poll_interval_ms; // 250
 */
export function scopeTimingOf(timing: DeclaredTiming): ScopeTimingValues {
  return {
    provider_client_deadline_ms: timing.provider_client_deadline_ms,
    provider_safety_release_ms: timing.provider_safety_release_ms,
    provider_execution_timeout_ms: timing.provider_execution_timeout_ms,
    treatment_poll_interval_ms: timing.treatment_poll_interval_ms,
  };
}
