// Catalogue group B row 44 (design §6.2): the controller consumed the runner canary in the
// reserved canary partition (BR-RUA-025 readiness, D-10).

import type { EventEnvelope } from '../../envelope.ts';
import type { Uuid4 } from '../../primitives.ts';

/** Schema: `schemas/group-b/controller_canary_acknowledged.schema.json`. */
export interface ControllerCanaryAcknowledged extends EventEnvelope<'controller_canary_acknowledged'> {
  readonly source: 'treatment_controller';
  readonly trial_id?: never;
  readonly trial_manifest_sha256?: never;
  readonly canary_event_id: Uuid4;
}
