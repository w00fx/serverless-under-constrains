// Catalogue group B row 43 (design §6.2, §9.11): a caller timeout that cannot signal
// (BR-RUA-025).

import type { EventEnvelope } from '../../envelope.ts';
import type { Uuid4 } from '../../primitives.ts';
import type { TreatmentState } from './vocabulary.ts';

interface CallerTimeoutRejectionBase extends EventEnvelope<'caller_timeout_rejected'> {
  readonly source: 'treatment_controller';
  readonly detail: string;
}

/** The stream record was not a valid caller timeout for this execution. */
export interface InvalidCallerTimeout extends CallerTimeoutRejectionBase {
  readonly reason: 'INVALID_EVENT';
  readonly caller_timeout_event_id?: Uuid4;
  readonly attempt_id?: Uuid4;
  readonly treatment_state?: TreatmentState;
}

/** A CONTROL trial has no treatment item to signal. */
export interface ControlTrialCallerTimeout extends CallerTimeoutRejectionBase {
  readonly reason: 'CONTROL_TRIAL';
  readonly caller_timeout_event_id: Uuid4;
  readonly attempt_id: Uuid4;
}

/** The timeout arrived while treatment was still ARMED. */
export interface BeforeCommitCallerTimeout extends CallerTimeoutRejectionBase {
  readonly reason: 'BEFORE_COMMIT';
  readonly caller_timeout_event_id: Uuid4;
  readonly attempt_id: Uuid4;
  readonly treatment_state: 'ARMED';
}

/** The timeout belongs to an attempt other than the targeted one. */
export interface NotTargetedCallerTimeout extends CallerTimeoutRejectionBase {
  readonly reason: 'NOT_TARGETED';
  readonly caller_timeout_event_id: Uuid4;
  readonly attempt_id: Uuid4;
  readonly treatment_state: 'COMMITTED_WAITING';
}

/** Schema: `schemas/group-b/caller_timeout_rejected.schema.json`. */
export type CallerTimeoutRejected =
  InvalidCallerTimeout | ControlTrialCallerTimeout | BeforeCommitCallerTimeout | NotTargetedCallerTimeout;
