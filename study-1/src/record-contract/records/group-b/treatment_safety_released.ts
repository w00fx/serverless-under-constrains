// Catalogue group B row 37 (design §6.2): a nonterminal treatment wait was released without
// an observed signal (BR-RUA-025, BR-RUA-014, BR-RUA-048).

import type { EventEnvelope } from '../../envelope.ts';
import type { DecimalString, Uuid4 } from '../../primitives.ts';
import type { SafetyReleaseCause } from './vocabulary.ts';

interface SafetyReleaseBase extends EventEnvelope<'treatment_safety_released'> {
  readonly source: 'refund_provider';
  readonly cause: SafetyReleaseCause;
}

/** Released before any commit: the armed treatment was never consumed. */
export interface ArmedSafetyRelease extends SafetyReleaseBase {
  readonly from_state: 'ARMED';
}

/** Released while the targeted commit waited at the barrier. */
export interface CommittedSafetyRelease extends SafetyReleaseBase {
  readonly from_state: 'COMMITTED_WAITING' | 'TIMEOUT_SIGNALLED' | 'TIMEOUT_OBSERVED';
  readonly provider_commit_id: Uuid4;
  readonly provider_call_id: Uuid4;
  readonly attempt_id: Uuid4;
  readonly elapsed_since_commit_ns?: DecimalString;
}

/** Schema: `schemas/group-b/treatment_safety_released.schema.json`. */
export type TreatmentSafetyReleased = ArmedSafetyRelease | CommittedSafetyRelease;
