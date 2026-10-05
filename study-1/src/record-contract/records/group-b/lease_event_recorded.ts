// Catalogue group B row 55 (design §6.2, §10.3): one lease transition (BR-RUA-045).

import type { EventEnvelope } from '../../envelope.ts';
import type { ExecutionKind, Sha256Hex, Uuid4, UtcMillis } from '../../primitives.ts';
import type { LeaseEvent, LeaseHealth } from './vocabulary.ts';

/** Schema: `schemas/group-b/lease_event_recorded.schema.json`. A foreign holder is named as a pair. */
export interface LeaseEventRecorded extends EventEnvelope<'lease_event_recorded'> {
  readonly source: 'coordination_lease';
  readonly trial_id?: never;
  readonly trial_manifest_sha256?: never;
  readonly lease_event: LeaseEvent;
  readonly owner_kind: ExecutionKind;
  readonly owner_id: Uuid4;
  readonly owner_manifest_sha256: Sha256Hex;
  readonly lease_version?: number;
  readonly lease_health?: LeaseHealth;
  readonly last_confirmed_at?: UtcMillis;
  readonly holder_owner_kind?: ExecutionKind;
  readonly holder_owner_id?: Uuid4;
  readonly detail?: string;
}
