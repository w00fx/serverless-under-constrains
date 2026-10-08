// CA-1, the PoC clock-alignment assumption (BR-RUA-025, D-05). BR-RUA-010 orders the provider
// commit and the caller timer by cross-source UTC wall clock, which is empirical ordering under
// this declared assumption, never a formal happened-before proof or a guaranteed clock bound
// (AC-RUA-002). Every treatment result names it through `clock_assumption_refs`.

import type { ClockAssumptionDeclaration } from '../record-contract/records/group-a/execution_manifest.ts';
import { CA_1_SCOPE, CA_1_STATEMENT } from '../record-contract/records/group-a/execution_manifest.ts';
import type { ClockAssumptionId, FidelityBasis, OrderingBasis } from '../record-contract/records/group-c/vocabulary.ts';

/**
 * CA-1 as the study declares it: a study assumption, not a provider guarantee.
 *
 * @example
 * CA_1.status; // 'declared_not_service_guaranteed'
 */
export const CA_1: ClockAssumptionDeclaration = {
  assumption_id: 'CA-1',
  assumption_type: 'clock_alignment',
  scope: CA_1_SCOPE,
  statement: CA_1_STATEMENT,
  status: 'declared_not_service_guaranteed',
};

/** The basis every treatment-fidelity result records (D-05). */
export const TREATMENT_FIDELITY_BASIS: Extract<FidelityBasis, 'causal_plus_cross_source_clock_assumption'> =
  'causal_plus_cross_source_clock_assumption';

/** The assumptions BR-RUA-010 relies on. */
export const TREATMENT_CLOCK_ASSUMPTION_REFS: readonly ClockAssumptionId[] = [CA_1.assumption_id];

/** How BR-RUA-010 orders events from different sources. */
export const TREATMENT_ORDERING_BASIS: OrderingBasis = 'cross_source_wall_clock';
