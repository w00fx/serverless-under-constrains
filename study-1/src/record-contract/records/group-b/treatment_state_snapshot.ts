// Catalogue group B row 61 (design §6.2): a strongly consistent read of the control treatment
// item after settlement (BR-RUA-025, BR-RUA-032).

import type { Uuid4, UtcMillis } from '../../primitives.ts';
import type { ExecutionCorrelation, ExecutionScoped, TrialScoped } from './shared-shapes.ts';
import type { SafetyReleaseCause, TreatmentState } from './vocabulary.ts';

/**
 * The treatment item: state, version and exactly the identities its state has recorded. The
 * schema ties them to the state: ARMED has none; COMMITTED_WAITING and later states carry the six
 * commit identities together (BR-RUA-025), TIMEOUT_SIGNALLED adds both signal ids,
 * TIMEOUT_OBSERVED the observation and RESPONSE_RELEASED the release; SAFETY_RELEASED keeps what
 * was recorded before it and alone may carry `safety_release_cause`.
 */
export interface TreatmentItem {
  readonly state: TreatmentState;
  readonly version: number;
  readonly targeted_attempt_id?: Uuid4;
  readonly provider_request_id?: Uuid4;
  readonly provider_call_id?: Uuid4;
  readonly provider_commit_id?: Uuid4;
  readonly provider_transaction_id?: Uuid4;
  readonly commit_event_id?: Uuid4;
  readonly signal_event_id?: Uuid4;
  readonly signal_caller_event_id?: Uuid4;
  readonly observed_event_id?: Uuid4;
  readonly release_event_id?: Uuid4;
  readonly safety_release_cause?: SafetyReleaseCause;
}

interface TreatmentSnapshotBase {
  readonly schema_version: 1;
  readonly record_type: 'treatment_state_snapshot';
  readonly partition_key: string;
  readonly captured_at: UtcMillis;
  readonly consistent_read: boolean;
}

/** The partition holds a treatment item (COMMIT_THEN_TIMEOUT trials and the probe). */
export interface TreatmentItemPresent extends TreatmentSnapshotBase {
  readonly item_present: true;
  readonly treatment: TreatmentItem;
}

/** No treatment item exists (CONTROL trials). */
export interface TreatmentItemAbsent extends TreatmentSnapshotBase {
  readonly item_present: false;
}

/** Schema: `schemas/group-b/treatment_state_snapshot.schema.json`. */
export type TreatmentStateSnapshot = ExecutionCorrelation &
  (TreatmentItemPresent | TreatmentItemAbsent) &
  (TrialScoped | ExecutionScoped);
