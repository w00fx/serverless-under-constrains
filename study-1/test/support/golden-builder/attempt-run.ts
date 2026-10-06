// The shared shape of one simulated provider attempt: the offsets of the design §9.12 sequences
// from the dispatch instant D, what the trial lends an attempt, and the ids, values and opening
// events every behavior builds on. The caller side lives in `attempt-simulation.ts`, the provider
// commit and treatment paths in `provider-commit-simulation.ts`.

import type { OutcomeClass } from '../../../src/attempt-lifecycle/outcome-classification.ts';
import type { JsonObject, Uuid4 } from '../../../src/record-contract/primitives.ts';
import type { GoldenEventLog, GoldenSourceInstance } from './golden-event-log.ts';
import type { AttemptPlan } from './golden-plan.ts';
import type { TrialContext } from './trial-context.ts';
import type { TrialTimeline } from './trial-timeline.ts';

/** Offsets from the dispatch instant, in milliseconds. */
export const ATTEMPT_OFFSETS = {
  registered_before_dispatch: 20,
  received: 60,
  accepted: 65,
  committed: 80,
  commit_acknowledged: 90,
  commit_confirmed: 95,
  response_returned: 100,
  outcome_after_response: 130,
  timer_fired: 3000,
  abort_requested: 3001,
  timeout_recorded: 3002,
  transport_settled: 3004,
  timed_out_outcome: 3006,
  signal_recorded: 3150,
  timeout_observed: 3250,
  response_released: 3251,
  late_commit: 3400,
  late_commit_acknowledged: 3410,
  late_commit_confirmed: 3420,
  late_response_returned: 3425,
  safety_release_after_ack: 15_000,
  late_signal_rejected: 20_000,
} as const;

/** What the rest of the trial shares with an attempt. */
export interface AttemptEnvironment {
  readonly context: TrialContext;
  readonly log: GoldenEventLog;
  readonly timeline: TrialTimeline;
  /** The trial's one controller instance, opened on first use. */
  readonly controller: () => GoldenSourceInstance;
}

/** One attempt to run inside an open caller invocation. */
export interface AttemptSetup {
  readonly plan: AttemptPlan;
  /** 1-based position of the attempt in the trial. */
  readonly number: number;
  readonly caller: GoldenSourceInstance;
  readonly invocation_event_id: Uuid4;
  /** Dispatch instant D; registration happens 20 ms earlier. */
  readonly dispatch_ms: number;
}

/** What the caller learned, for the request state that follows. */
export interface AttemptResult {
  readonly attempt_id: Uuid4;
  readonly outcome_event_id: Uuid4;
  readonly outcome_class: OutcomeClass;
  readonly outcome_ms: number;
}

export interface AttemptIds {
  readonly attempt_id: Uuid4;
  readonly provider_request_id: Uuid4;
  readonly provider_call_id: Uuid4;
  readonly provider_commit_id: Uuid4;
  readonly provider_transaction_id: Uuid4;
}

/** The ids, values and emitted events one behavior builds on. */
export interface AttemptRun {
  readonly env: AttemptEnvironment;
  readonly setup: AttemptSetup;
  readonly ids: AttemptIds;
  readonly correlation: JsonObject;
  readonly values: { readonly payment_id: string; readonly amount_minor: number; readonly currency: string };
  readonly provider: GoldenSourceInstance;
  readonly dispatch_event_id: Uuid4;
  readonly received_event_id: Uuid4;
  readonly at: (offsetMs: number) => number;
}

/**
 * A duration in milliseconds as the decimal nanosecond string the journal records carry.
 *
 * @example
 * nanos(110); // '110000000'
 */
export function nanos(milliseconds: number): string {
  return `${String(milliseconds)}000000`;
}
