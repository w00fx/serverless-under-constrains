// Catalogue group B row 45 (design §6.2): an execution phase P1-P9 changed status
// (BR-RUA-040; design §10.2).

import type { EventEnvelope } from '../../envelope.ts';
import type { StructuredReason } from '../../primitives.ts';
import type { ExecutionPhase, StepStatus } from './vocabulary.ts';

/** Schema: `schemas/group-b/phase_transition_recorded.schema.json`. */
export interface PhaseTransitionRecorded extends EventEnvelope<'phase_transition_recorded'> {
  readonly source: 'runner';
  readonly trial_id?: never;
  readonly trial_manifest_sha256?: never;
  readonly phase: ExecutionPhase;
  readonly status: StepStatus;
  readonly reasons: readonly StructuredReason[];
}
