// Catalogue group B row 48 (design §6.2): the control treatment item was written ARMED before
// publication (BR-RUA-025).

import type { EventEnvelope } from '../../envelope.ts';

/** Schema: `schemas/group-b/treatment_armed.schema.json`. */
export interface TreatmentArmed extends EventEnvelope<'treatment_armed'> {
  readonly source: 'runner';
  readonly partition_key: string;
  readonly treatment_state: 'ARMED';
  readonly treatment_version: number;
}
