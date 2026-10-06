// The hard safety maximums of each execution kind (BR-RUA-046; OR-RUA-003, OR-RUA-004,
// OR-RUA-005). They are maximums, not expected durations: the active-time deadline stops new
// trials, and exceeding the total target is a duration breach, never permission to abandon
// cleanup. Every duration is in milliseconds; the spending ceiling is an admission boundary,
// not a billing guarantee.

import type { ExecutionKind, MoneyDecimal } from '../record-contract/primitives.ts';
import type { DeclaredSafety } from '../record-contract/records/group-a/execution_manifest.ts';

/** The only Region every execution runs in (OR-RUA-003..005). */
export const SAFETY_REGION = 'us-east-1';

export interface SafetyLimits {
  readonly active_ms: number;
  readonly cleanup_ms: number;
  readonly total_ms: number;
  readonly ceiling_usd: MoneyDecimal;
  readonly region: typeof SAFETY_REGION;
}

/** OR-RUA-003: 4,500 s active, 900 s cleanup, 5,400 s total, USD 5.00. */
export const RUN_SAFETY: SafetyLimits = {
  active_ms: 4_500_000,
  cleanup_ms: 900_000,
  total_ms: 5_400_000,
  ceiling_usd: '5.00' as MoneyDecimal,
  region: SAFETY_REGION,
};

/** OR-RUA-004: 600 s active, 600 s cleanup, 1,200 s total, USD 1.00. */
export const PROBE_SAFETY: SafetyLimits = {
  active_ms: 600_000,
  cleanup_ms: 600_000,
  total_ms: 1_200_000,
  ceiling_usd: '1.00' as MoneyDecimal,
  region: SAFETY_REGION,
};

/** OR-RUA-005: every variant validation reuses the canonical run maximums. */
export const VALIDATION_SAFETY: SafetyLimits = RUN_SAFETY;

const LIMITS_BY_KIND: Readonly<Record<ExecutionKind, SafetyLimits>> = {
  RUN: RUN_SAFETY,
  TRANSPORT_PROBE: PROBE_SAFETY,
  VARIANT_VALIDATION: VALIDATION_SAFETY,
};

/**
 * The safety maximums of an execution kind.
 *
 * @example
 * safetyLimitsFor('TRANSPORT_PROBE').total_ms; // 1200000
 */
export function safetyLimitsFor(kind: ExecutionKind): SafetyLimits {
  return LIMITS_BY_KIND[kind];
}

/**
 * The safety inputs an execution manifest declares (BR-RUA-040), with the single concurrent
 * owner per Study, account and Region of OR-RUA-003 and OR-RUA-005.
 *
 * @example
 * declaredSafetyOf(RUN_SAFETY).concurrent_owners; // 1
 */
export function declaredSafetyOf(limits: SafetyLimits): DeclaredSafety {
  return {
    region: limits.region,
    active_ms: limits.active_ms,
    cleanup_ms: limits.cleanup_ms,
    total_ms: limits.total_ms,
    ceiling_usd: limits.ceiling_usd,
    concurrent_owners: 1,
  };
}
