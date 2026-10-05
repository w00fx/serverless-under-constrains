// Catalogue group B row 53 (design §6.2, §10.2): the active trial entered controlled
// interruption (BR-RUA-045, BR-RUA-046).

import type { EventEnvelope } from '../../envelope.ts';
import type { InterruptionCause } from './vocabulary.ts';

/** Schema: `schemas/group-b/trial_interrupted.schema.json`. */
export interface TrialInterrupted extends EventEnvelope<'trial_interrupted'> {
  readonly source: 'runner';
  readonly cause: InterruptionCause;
  readonly detail: string;
}
