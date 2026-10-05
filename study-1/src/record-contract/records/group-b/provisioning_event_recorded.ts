// Catalogue group B row 46 (design §6.2, §9.8 D1-D4): one step of deployment from the
// verified temporary copy (BR-RUA-040, BR-RUA-042, D-25).

import type { EventEnvelope } from '../../envelope.ts';
import type { Sha256Hex, StructuredReason } from '../../primitives.ts';
import type { ProvisioningEvent } from './vocabulary.ts';

/**
 * Schema: `schemas/group-b/provisioning_event_recorded.schema.json`. Inventory checks carry
 * `inventory_sha256`, `DEPLOY_STARTED` carries `stack_name`, `STACK_ID_RECORDED` carries
 * `stack_id`, and `DEPLOY_FAILED` carries at least one reason.
 */
export interface ProvisioningEventRecorded extends EventEnvelope<'provisioning_event_recorded'> {
  readonly source: 'runner';
  readonly trial_id?: never;
  readonly trial_manifest_sha256?: never;
  readonly provisioning_event: ProvisioningEvent;
  readonly inventory_sha256?: Sha256Hex;
  readonly stack_name?: string;
  readonly stack_id?: string;
  readonly reasons: readonly StructuredReason[];
}
