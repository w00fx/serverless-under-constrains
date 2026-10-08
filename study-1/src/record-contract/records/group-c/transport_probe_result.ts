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

/**
 * The observed probe workload counts (design §8.11). BR-RUA-027 expects exactly 1 / 1 / 1; any
 * count above 1 makes the probe `invalid`, and counts of 0 are left to the conditions.
 */
export interface ProbeCardinality {
  readonly caller_invocations: number;
  readonly accepted_provider_calls: number;
  readonly committed_transactions: number;
}

/** The BR-RUA-027 expected cardinality, which a `pass` carries (AC-RUA-021). */
export interface ExpectedProbeCardinality extends ProbeCardinality {
  readonly caller_invocations: 1;
  readonly accepted_provider_calls: 1;
  readonly committed_transactions: 1;
}

interface TransportProbeResultFields extends ExecutionScoped {
  readonly schema_version: 1;
  readonly record_type: 'transport_probe_result';
  readonly transport_probe_id: Uuid4;
  readonly execution_manifest_sha256: Sha256Hex;
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
 * BR-RUA-027 precedence over the record's own members (the schema enforces each step): an
 * invalid probe (a count above 1, design §8.11) is indeterminate; otherwise an unaffected
 * failing condition gives `fail`; otherwise six passing conditions with verified evidence give
 * `pass`; otherwise `indeterminate`. A `pass` also carries the expected cardinality 1 / 1 / 1
 * (AC-RUA-021). A `pass` with `indeterminate` validity follows the BR-RUA-027 precedence as
 * written; only BR-RUA-026 usability requires `probe_validity = valid`. The six conditions and
 * the treatment-fidelity rules of design §8.10 are not expressible in this type; the schema
 * holds them.
 */
export type ProbeVerdictOutcome =
  | {
      readonly transport_probe_verdict: 'pass';
      readonly probe_validity: Exclude<TrialValidity, 'invalid'>;
      readonly probe_cardinality: ExpectedProbeCardinality;
      readonly evidence_integrity: 'verified';
    }
  | {
      readonly transport_probe_verdict: Extract<PreservationVerdict, 'fail'>;
      readonly probe_validity: Exclude<TrialValidity, 'invalid'>;
      readonly probe_cardinality: ProbeCardinality;
    }
  | {
      readonly transport_probe_verdict: Extract<PreservationVerdict, 'indeterminate'>;
      readonly probe_validity: TrialValidity;
      readonly probe_cardinality: ProbeCardinality;
    };

/** Schema: `schemas/group-c/transport_probe_result.schema.json`. */
export type TransportProbeResult = TransportProbeResultFields & ProbeVerdictOutcome;
