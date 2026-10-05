// Catalogue group B row 26 (design §6.2): the outcome and dispatch state of one attempt
// (BR-RUA-021, BR-RUA-015; design §9.9).

import type { EventEnvelope } from '../../envelope.ts';
import type { DecimalString, StructuredReason, Uuid4 } from '../../primitives.ts';
import type { AttemptCorrelation } from './shared-shapes.ts';
import type { AttemptFailureCode, CallerEventSource, DispatchState, ProviderRejectionReason } from './vocabulary.ts';

interface OutcomeBase extends EventEnvelope<'attempt_outcome_recorded'>, AttemptCorrelation {
  readonly source: CallerEventSource;
  readonly dispatch_to_settlement_ns?: DecimalString;
  readonly executed_version?: string;
  /** Raw `X-Amz-Function-Error` value when the response carried one. */
  readonly function_error?: string;
}

/** The provider committed and its response echoed the call and transaction ids. */
export interface SucceededOutcome extends OutcomeBase {
  readonly outcome: 'SUCCEEDED';
  readonly dispatch_state: 'DISPATCHED';
  readonly provider_call_id: Uuid4;
  readonly provider_transaction_id: Uuid4;
}

/** The provider rejected the call; no transaction exists. */
export interface RejectedOutcome extends OutcomeBase {
  readonly outcome: 'REJECTED';
  readonly dispatch_state: 'DISPATCHED';
  readonly provider_call_id: Uuid4;
  readonly rejection_reason: ProviderRejectionReason;
}

/** The application timer won after dispatch (BR-RUA-023). */
export interface TimedOutOutcome extends OutcomeBase {
  readonly outcome: 'TIMED_OUT';
  readonly dispatch_state: 'DISPATCHED';
  readonly provider_call_id?: Uuid4;
  readonly provider_transaction_id?: Uuid4;
}

/** Anything else; the dispatch state decides whether the outcome is ambiguous (BR-RUA-004). */
export interface FailedOutcome extends OutcomeBase {
  readonly outcome: 'FAILED';
  readonly dispatch_state: DispatchState;
  readonly failure: StructuredReason & { readonly code: AttemptFailureCode };
  readonly provider_call_id?: Uuid4;
  readonly provider_transaction_id?: Uuid4;
}

/** Schema: `schemas/group-b/attempt_outcome_recorded.schema.json`. */
export type AttemptOutcomeRecorded = SucceededOutcome | RejectedOutcome | TimedOutOutcome | FailedOutcome;
