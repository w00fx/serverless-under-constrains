// Catalogue group B row 56 (design §6.2, §10.4): one action of cleanup step 1-12
// (BR-RUA-048, BR-RUA-049, BR-RUA-050).

import type { EventEnvelope } from '../../envelope.ts';
import type { StructuredReason } from '../../primitives.ts';
import type { CleanupMode, OwnershipBasis, StepStatus } from './vocabulary.ts';

/**
 * Schema: `schemas/group-b/cleanup_action_recorded.schema.json`. A resource is named by
 * `resource_type` and `resource_identifier` together; `ownership_basis` needs the identifier.
 */
export interface CleanupActionRecorded extends EventEnvelope<'cleanup_action_recorded'> {
  readonly source: 'cleanup';
  readonly trial_id?: never;
  readonly trial_manifest_sha256?: never;
  /** Cleanup step 1-12 of BR-RUA-048. */
  readonly step: number;
  readonly step_status: StepStatus;
  readonly cleanup_mode: CleanupMode;
  /** True for a transition the cleanup itself caused (BR-RUA-048 step 6). */
  readonly cleanup_induced: boolean;
  /** UPPER_SNAKE action name, for example `DELETE_STACK`. */
  readonly action: string;
  readonly resource_type?: string;
  readonly resource_identifier?: string;
  readonly ownership_basis?: OwnershipBasis;
  readonly reasons: readonly StructuredReason[];
}
