// The transport-probe result (CTR-RUA-003, BR-RUA-027, design §8.11), frozen before cleanup. It
// joins the six treatment conditions, treatment fidelity, the probe's validity from its counted
// workload, and the probe's evidence integrity, then derives the verdict by the exact BR-RUA-027
// precedence. Ordering is cross-source wall clock under CA-1; the record has no member that could
// claim formal happened-before proof (AC-RUA-002).

import type { IngestedEvidence } from '../../evidence-ingestion/ingestion-model.ts';
import { err, ok } from '../../record-contract/primitives.ts';
import type { Result, StructuredReason, UtcMillis } from '../../record-contract/primitives.ts';
import type { ConditionResult } from '../../record-contract/records/group-c/shared-shapes.ts';
import type {
  ExpectedProbeCardinality,
  ProbeCardinality,
  ProbeVerdictOutcome,
  TransportProbeResult,
} from '../../record-contract/records/group-c/transport_probe_result.ts';
import type {
  ApplicableGateValue,
  PreservationVerdict,
  TrialValidity,
} from '../../record-contract/records/group-c/vocabulary.ts';
import { TREATMENT_ORDERING_BASIS } from '../../treatment-fidelity/clock-assumption.ts';
import { canonicalRefs, uniqueReasons } from '../../treatment-fidelity/condition-result.ts';
import { evaluateTreatmentConditions } from '../../treatment-fidelity/treatment-conditions.ts';
import { deriveTreatmentFidelity } from '../../treatment-fidelity/treatment-fidelity.ts';
import { buildTreatmentView } from '../../treatment-fidelity/treatment-view.ts';
import { assessProbeEvidenceIntegrity } from './probe-evidence-integrity.ts';
import { assessProbeValidity } from './probe-validity.ts';
import { deriveProbeVerdict } from './probe-verdict.ts';

export interface ProbeResultInput {
  readonly evidence: IngestedEvidence;
  readonly checked_at: UtcMillis;
}

/**
 * Builds the probe result from ingested probe evidence. Refused, with a reason, when the evidence
 * names no transport-probe execution (its execution manifest is missing or of another kind) or
 * has no treatment view.
 *
 * @example
 * const result = buildProbeResult({ evidence: ingestEvidence(probeInput, validator), checked_at });
 * if (result.ok) result.value.transport_probe_verdict; // 'pass' | 'fail' | 'indeterminate'
 */
export function buildProbeResult(input: ProbeResultInput): Result<TransportProbeResult, readonly StructuredReason[]> {
  const { evidence } = input;
  const execution = evidence.scope.execution;
  const manifestDigest = evidence.scope.execution_manifest_sha256;
  if (execution?.execution_kind !== 'TRANSPORT_PROBE' || manifestDigest === undefined) {
    const detail = `the evidence names execution kind ${execution?.execution_kind ?? '(none)'}; expected a TRANSPORT_PROBE execution manifest`;
    return err([{ code: 'PROBE_EXECUTION_UNKNOWN', subject: 'CTR-RUA-003', detail }]);
  }
  const view = buildTreatmentView(evidence);
  if (!view.ok) {
    return err(view.error);
  }
  const conditions = evaluateTreatmentConditions(view.value);
  const fidelity = deriveTreatmentFidelity(conditions, view.value);
  const validity = assessProbeValidity(evidence);
  const integrity = assessProbeEvidenceIntegrity(evidence, validity);
  const verdict = deriveProbeVerdict(validity.probe_validity, conditions, integrity.value);
  return ok({
    schema_version: 1,
    record_type: 'transport_probe_result',
    transport_probe_id: execution.transport_probe_id,
    execution_manifest_sha256: manifestDigest,
    evidence_integrity: integrity.value,
    treatment_fidelity: fidelity.treatment_fidelity,
    fidelity_basis: fidelity.fidelity_basis,
    clock_assumption_refs: fidelity.clock_assumption_refs,
    ordering_basis: TREATMENT_ORDERING_BASIS,
    condition_results: conditions,
    evidence_refs: canonicalRefs([
      ...conditions.flatMap((condition) => condition.evidence_refs),
      ...fidelity.evidence_refs,
      ...integrity.evidence_refs,
      ...validity.evidence_refs,
    ]),
    indeterminate_reasons: uniqueReasons([
      ...(validity.probe_validity === 'valid' ? [] : validity.reasons),
      ...(integrity.value === 'verified' ? [] : integrity.reasons),
      ...conditions.flatMap((condition: ConditionResult) => condition.indeterminate_reasons),
    ]),
    checked_at: input.checked_at,
    ...verdictOutcome(verdict, validity.probe_validity, validity.cardinality, integrity.value),
  });
}

// The verdict's own members, typed by its outcome. A `pass` follows from a probe that is not
// invalid (no count above 1) with verified evidence (no count of 0), so it carries 1/1/1.
function verdictOutcome(
  verdict: PreservationVerdict,
  validity: TrialValidity,
  cardinality: ProbeCardinality,
  integrity: ApplicableGateValue,
): ProbeVerdictOutcome {
  if (verdict === 'pass' && validity !== 'invalid' && integrity === 'verified' && isExpectedCardinality(cardinality)) {
    return {
      transport_probe_verdict: 'pass',
      probe_validity: validity,
      probe_cardinality: cardinality,
      evidence_integrity: integrity,
    };
  }
  if (verdict === 'fail' && validity !== 'invalid') {
    return { transport_probe_verdict: 'fail', probe_validity: validity, probe_cardinality: cardinality };
  }
  return { transport_probe_verdict: 'indeterminate', probe_validity: validity, probe_cardinality: cardinality };
}

function isExpectedCardinality(cardinality: ProbeCardinality): cardinality is ExpectedProbeCardinality {
  return (
    cardinality.caller_invocations === 1 &&
    cardinality.accepted_provider_calls === 1 &&
    cardinality.committed_transactions === 1
  );
}
