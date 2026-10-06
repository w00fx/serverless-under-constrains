// The declarative plan a golden scenario is built from (design §12.4 "the scenario-builder
// operations"). A base scenario names an execution (the canonical run, one variant validation or
// the transport probe) and its subject trial; a trial plan says what each source delivery and each
// provider attempt does. The defaults are the spec's Expected Configured Trace (CAP-RUA "Expected
// Configured Trace"): CONTROL is one delivery, one call and one transaction; conventional
// COMMIT_THEN_TIMEOUT is two deliveries, two calls and two transactions; Durable
// COMMIT_THEN_TIMEOUT is one delivery with two step attempts and two transactions.

import type { Scenario, VariantId } from '../../../src/record-contract/primitives.ts';
import type { ProviderRejectionReason } from '../../../src/record-contract/records/group-b/vocabulary.ts';

/**
 * What one provider attempt does, end to end across the caller, provider and controller:
 * - `succeeded`: an untargeted commit, `provider_response_returned`, caller `SUCCEEDED`;
 * - `targeted_timeout`: the BR-RUA-025 treatment path (targeted commit, caller timer wins, signal,
 *   observation, release), caller `TIMED_OUT`;
 * - `safety_release`: a targeted commit and a caller timeout the controller never signals, so the
 *   provider safety-releases 15 s after the commit (OR-RUA-002), caller `TIMED_OUT`;
 * - `untargeted_timeout`: a CONTROL commit slower than the 3 s deadline; the controller rejects the
 *   timeout as `CONTROL_TRIAL` (the uncontrolled timeout of AC-RUA-029), caller `TIMED_OUT`;
 * - `rejected`: the provider rejects the call, caller `REJECTED`;
 * - `commit_failed`: the commit fails definitively, the provider returns a function error, caller
 *   `FAILED` with `DISPATCHED`.
 */
export const ATTEMPT_BEHAVIORS = [
  'succeeded',
  'targeted_timeout',
  'safety_release',
  'untargeted_timeout',
  'rejected',
  'commit_failed',
] as const;
export type AttemptBehavior = (typeof ATTEMPT_BEHAVIORS)[number];

/** One provider attempt; omitted values are the OR-RUA-001 fixture. */
export interface AttemptPlan {
  readonly behavior: AttemptBehavior;
  readonly amount_minor?: number;
  readonly currency?: string;
  readonly refund_request_id?: string;
  readonly payment_id?: string;
  /** Only for `rejected`; `PAYMENT_NOT_FOUND` when omitted. */
  readonly rejection_reason?: ProviderRejectionReason;
}

/** One source delivery: one conventional invocation, or one Durable execution with its step attempts. */
export interface DeliveryPlan {
  readonly attempts: readonly AttemptPlan[];
}

/**
 * `completes`: the request reaches a terminal state and settlement can be established.
 * `active_at_deadline`: the request never finishes, so the message stays in flight and settlement
 * is not established by the 600 s deadline (BR-RUA-032; the matrix row "processing active at
 * deadline").
 */
export const PROCESSING_ENDINGS = ['completes', 'active_at_deadline'] as const;
export type ProcessingEnding = (typeof PROCESSING_ENDINGS)[number];

export interface TrialPlan {
  readonly deliveries: readonly DeliveryPlan[];
  readonly processing: ProcessingEnding;
}

/** The executions a base scenario can belong to. */
export type GoldenExecution = 'run' | 'validation-conventional' | 'validation-durable' | 'probe';

/** A base: an execution plus its subject trial (the probe has none). */
export interface BaseScenario {
  readonly execution: GoldenExecution;
  /** 1-based position of the subject trial in the declared order; 0 for the probe. */
  readonly sequence: number;
}

/**
 * Every base a golden case can start from. A run or validation base holds the execution prefix as
 * it stands when its subject trial is frozen: every earlier trial plus the subject trial.
 */
export const BASE_SCENARIOS = {
  'run-conventional-control': { execution: 'run', sequence: 1 },
  'run-durable-control': { execution: 'run', sequence: 2 },
  'run-conventional-treatment': { execution: 'run', sequence: 3 },
  'run-durable-treatment': { execution: 'run', sequence: 4 },
  'validation-conventional-control': { execution: 'validation-conventional', sequence: 1 },
  'validation-conventional-treatment': { execution: 'validation-conventional', sequence: 2 },
  'validation-durable-control': { execution: 'validation-durable', sequence: 1 },
  'validation-durable-treatment': { execution: 'validation-durable', sequence: 2 },
  probe: { execution: 'probe', sequence: 0 },
} as const satisfies Readonly<Record<string, BaseScenario>>;
export type BaseScenarioId = keyof typeof BASE_SCENARIOS;
export const BASE_SCENARIO_IDS = Object.keys(BASE_SCENARIOS) as readonly BaseScenarioId[];

/** A declared trial: its position, variant and scenario (BR-RUA-019, BR-RUA-038). */
export interface DeclaredTrialShape {
  readonly sequence: number;
  readonly variant_id: VariantId;
  readonly scenario: Scenario;
}

/**
 * The declared trials of an execution, in their only allowed order.
 *
 * @example
 * declaredTrialsOf('validation-durable'); // durable CONTROL, then durable COMMIT_THEN_TIMEOUT
 */
export function declaredTrialsOf(execution: GoldenExecution): readonly DeclaredTrialShape[] {
  switch (execution) {
    case 'run':
      return [
        { sequence: 1, variant_id: 'conventional', scenario: 'CONTROL' },
        { sequence: 2, variant_id: 'durable', scenario: 'CONTROL' },
        { sequence: 3, variant_id: 'conventional', scenario: 'COMMIT_THEN_TIMEOUT' },
        { sequence: 4, variant_id: 'durable', scenario: 'COMMIT_THEN_TIMEOUT' },
      ];
    case 'validation-conventional':
      return validationTrials('conventional');
    case 'validation-durable':
      return validationTrials('durable');
    case 'probe':
      return [];
  }
}

function validationTrials(variant: VariantId): readonly DeclaredTrialShape[] {
  return [
    { sequence: 1, variant_id: variant, scenario: 'CONTROL' },
    { sequence: 2, variant_id: variant, scenario: 'COMMIT_THEN_TIMEOUT' },
  ];
}

/** The caller of a plan: a variant, or the probe caller (BR-RUA-027). */
export type PlanCaller = VariantId | 'probe';

/**
 * The Expected Configured Trace plan of a caller and scenario (the probe always runs the treatment).
 *
 * @example
 * defaultTrialPlan('durable', 'COMMIT_THEN_TIMEOUT').deliveries[0]?.attempts.length; // 2
 */
export function defaultTrialPlan(caller: PlanCaller, scenario: Scenario): TrialPlan {
  if (caller === 'probe' || scenario === 'CONTROL') {
    const first: AttemptPlan = { behavior: caller === 'probe' ? 'targeted_timeout' : 'succeeded' };
    return { deliveries: [{ attempts: [first] }], processing: 'completes' };
  }
  if (caller === 'conventional') {
    return {
      deliveries: [{ attempts: [{ behavior: 'targeted_timeout' }] }, { attempts: [{ behavior: 'succeeded' }] }],
      processing: 'completes',
    };
  }
  return {
    deliveries: [{ attempts: [{ behavior: 'targeted_timeout' }, { behavior: 'succeeded' }] }],
    processing: 'completes',
  };
}

/**
 * Tells whether an attempt outcome is ambiguous (BR-RUA-022 outcome classes): every behavior that
 * ends `TIMED_OUT` or `FAILED` after dispatch.
 *
 * @example
 * isAmbiguousBehavior('commit_failed'); // true
 */
export function isAmbiguousBehavior(behavior: AttemptBehavior): boolean {
  return behavior !== 'succeeded' && behavior !== 'rejected';
}

/**
 * Tells whether an attempt's commit consumes the armed treatment (BR-RUA-025 targeted commit).
 *
 * @example
 * isTargetedBehavior('safety_release'); // true
 * isTargetedBehavior('untargeted_timeout'); // false
 */
export function isTargetedBehavior(behavior: AttemptBehavior): boolean {
  return behavior === 'targeted_timeout' || behavior === 'safety_release';
}
