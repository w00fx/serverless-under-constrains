// Catalogue group C row 69 (design §6.2, §6.3, §8.11): the probe result, frozen before cleanup
// (CTR-RUA-003, BR-RUA-027). The schema has no property that could claim formal happened-before
// proof: ordering is cross-source wall clock under CA-1 (AC-RUA-002).

import type { EvidenceRef } from '../../evidence-refs.ts';
import type { Sha256Hex, StructuredReason, Uuid4, UtcMillis } from '../../primitives.ts';
import type { ExecutionScoped, SixConditionResults } from './shared-shapes.ts';
import type {
  ApplicableGateValue,
  ClockAssumptionId,
  FidelityBasis,
  OrderingBasis,
  PreservationVerdict,
  TrialValidity,
} from './vocabulary.ts';

/** BR-RUA-027 expected cardinality is exactly 1 / 1 / 1. */
export interface ProbeCardinality {
  readonly caller_invocations: number;
  readonly accepted_provider_calls: number;
  readonly committed_transactions: number;
}

interface TransportProbeResultFields extends ExecutionScoped {
  readonly schema_version: 1;
  readonly record_type: 'transport_probe_result';
  readonly transport_probe_id: Uuid4;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly probe_cardinality: ProbeCardinality;
  readonly evidence_integrity: ApplicableGateValue;
  readonly treatment_fidelity: ApplicableGateValue;
  readonly fidelity_basis: Exclude<FidelityBasis, 'not_applicable'>;
  readonly clock_assumption_refs: readonly ClockAssumptionId[];
  readonly ordering_basis: OrderingBasis;
  readonly condition_results: SixConditionResults;
  readonly evidence_refs: readonly EvidenceRef[];
  readonly indeterminate_reasons: readonly StructuredReason[];
  readonly checked_at: UtcMillis;
}

/**
 * BR-RUA-027 precedence: an invalid probe is indeterminate; a `pass` needs a valid probe,
 * verified evidence and six passing conditions.
 */
export type ProbeVerdictOutcome =
  | {
      readonly transport_probe_verdict: 'pass';
      readonly probe_validity: 'valid';
      readonly evidence_integrity: 'verified';
    }
  | { readonly transport_probe_verdict: Exclude<PreservationVerdict, 'pass'>; readonly probe_validity: TrialValidity };

/** Schema: `schemas/group-c/transport_probe_result.schema.json`. */
export type TransportProbeResult = TransportProbeResultFields & ProbeVerdictOutcome;
