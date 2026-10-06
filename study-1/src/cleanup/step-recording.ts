// What a cleanup step reports: one journal action per item it acted on, and a terminal outcome.
// The orchestrator turns an item into a full `cleanup_action_recorded` body (step number, mode,
// `step_status: started` while the step runs).

import type { StructuredReason } from '../record-contract/primitives.ts';
import type { OwnershipBasis } from '../record-contract/records/group-b/vocabulary.ts';

/** One item-level action of the running step. */
export interface ItemAction {
  readonly action: string;
  readonly resource_type: string;
  readonly resource_identifier: string;
  readonly ownership_basis?: OwnershipBasis;
  /** True only for transitions the cleanup itself caused (BR-RUA-048 step 6). */
  readonly cleanup_induced?: boolean;
  readonly reasons?: readonly StructuredReason[];
}

/** Records one item-level action of the running step. */
export type ItemRecorder = (item: ItemAction) => Promise<void>;

/** The terminal status of one step and why. */
export interface StepOutcome {
  readonly status: 'succeeded' | 'failed' | 'skipped';
  readonly reasons: readonly StructuredReason[];
}

/**
 * The outcome of a step from the failure reasons its items collected: `succeeded` without any.
 *
 * @example
 * outcomeFromFailures([]); // { status: 'succeeded', reasons: [] }
 */
export function outcomeFromFailures(failures: readonly StructuredReason[]): StepOutcome {
  return { status: failures.length === 0 ? 'succeeded' : 'failed', reasons: failures };
}
