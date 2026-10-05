// Catalogue group B row 47 (design §6.2): the fresh partition was absent in every listed
// table before the trial (BR-RUA-019).

import type { EventEnvelope } from '../../envelope.ts';
import type { TrialPartitionTableRole } from './vocabulary.ts';

/** Schema: `schemas/group-b/trial_partitions_verified_absent.schema.json`. */
export interface TrialPartitionsVerifiedAbsent extends EventEnvelope<'trial_partitions_verified_absent'> {
  readonly source: 'runner';
  readonly partition_key: string;
  readonly table_roles: readonly TrialPartitionTableRole[];
}
