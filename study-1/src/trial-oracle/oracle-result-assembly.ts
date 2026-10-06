// The typed parts of an oracle result (CTR-RUA-001, design §6.3, §8.6-§8.8): the verdict outcome
// (verdict, `correct_completion`, terminal reason), the scenario assessment (G4a for CONTROL;
// fidelity, basis, CA-1 and the six conditions for a treatment), the union of indeterminate
// reasons, and the ledger snapshot reference. Each builder keeps the cross-field rules of the
// schema by construction.

import type { IngestedEvidence } from '../evidence-ingestion/ingestion-model.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import type { GateValue, StructuredReason } from '../record-contract/primitives.ts';
import type { ProcessingTerminalReason } from '../record-contract/records/group-b/vocabulary.ts';
import type {
  RuleResult,
  ScenarioAssessment,
  ValidityGate,
  VerdictOutcome,
} from '../record-contract/records/group-c/oracle_result.ts';
import type { ArtifactRef } from '../record-contract/records/group-c/shared-shapes.ts';
import type { ApplicableGateValue, PreservationVerdict } from '../record-contract/records/group-c/vocabulary.ts';
import { subjectArtifactState } from '../treatment-fidelity/subject-artifacts.ts';
import { deriveCorrectCompletion } from './preservation-verdict.ts';
import type { TreatmentAssessment } from './validity-gates.ts';

/** The digest of zero bytes: the reference of a ledger snapshot that was never stored. */
const EMPTY_SHA256 = sha256Hex(new Uint8Array());

/**
 * The verdict, completion and terminal reason as one typed outcome (BR-RUA-030, D-17). A pass or
 * fail without a terminal reason cannot come out of a valid trial, so it is reported
 * indeterminate rather than recorded as an impossible combination.
 *
 * @example
 * verdictOutcome('pass', 'RETRIES_EXHAUSTED'); // { preservation_verdict: 'pass', correct_completion: false, ... }
 */
export function verdictOutcome(
  verdict: PreservationVerdict,
  terminal: ProcessingTerminalReason | null,
): VerdictOutcome {
  const completion = deriveCorrectCompletion(verdict, terminal);
  if (terminal === null || completion === null) {
    return { preservation_verdict: 'indeterminate', correct_completion: null, processing_terminal_reason: terminal };
  }
  if (verdict === 'fail') {
    return { preservation_verdict: 'fail', correct_completion: false, processing_terminal_reason: terminal };
  }
  return terminal === 'SUCCEEDED'
    ? { preservation_verdict: 'pass', correct_completion: true, processing_terminal_reason: terminal }
    : { preservation_verdict: 'pass', correct_completion: false, processing_terminal_reason: terminal };
}

/**
 * The scenario members: G4a for CONTROL, fidelity with its basis and conditions for a treatment.
 *
 * @example
 * scenarioAssessment({ scenario: 'CONTROL' }, gates).treatment_fidelity; // 'not_applicable'
 */
export function scenarioAssessment(treatment: TreatmentAssessment, controlIntegrity: ValidityGate): ScenarioAssessment {
  if (treatment.scenario === 'CONTROL') {
    return {
      scenario: 'CONTROL',
      control_integrity: applicableGateValue(controlIntegrity.value),
      treatment_fidelity: 'not_applicable',
      fidelity_basis: 'not_applicable',
      clock_assumption_refs: [],
      treatment_condition_results: [],
    };
  }
  return {
    scenario: 'COMMIT_THEN_TIMEOUT',
    control_integrity: 'not_applicable',
    treatment_fidelity: treatment.fidelity.treatment_fidelity,
    fidelity_basis: treatment.fidelity.fidelity_basis,
    clock_assumption_refs: treatment.fidelity.clock_assumption_refs,
    treatment_condition_results: treatment.conditions,
  };
}

/**
 * A gate value of a gate that applies; `not_applicable` there means the gate could not be judged.
 *
 * @example
 * applicableGateValue('not_applicable'); // 'unverified'
 */
export function applicableGateValue(value: GateValue): ApplicableGateValue {
  return value === 'not_applicable' ? 'unverified' : value;
}

/**
 * The union of the reasons of every non-verified gate and every indeterminate rule, without
 * repeats, sorted by subject, code, artifact path, event id and detail (design §8.6).
 *
 * @example
 * indeterminateReasons(gates, rules); // [] for a valid trial whose rules all conclude
 */
export function indeterminateReasons(
  gates: readonly ValidityGate[],
  rules: readonly RuleResult[],
): readonly StructuredReason[] {
  const reasons = [
    ...gates.filter((gate) => gate.value === 'invalid' || gate.value === 'unverified').flatMap((gate) => gate.reasons),
    ...rules.filter((rule) => rule.result === 'indeterminate').flatMap((rule) => rule.indeterminate_reasons),
  ];
  const unique = new Map(reasons.map((reason) => [sortKey(reason), reason]));
  return [...unique.entries()].toSorted(([a], [b]) => (a < b ? -1 : 1)).map(([, reason]) => reason);
}

/**
 * CTR-RUA-001 `ledger_snapshot_ref`: the stored snapshot's path and digest, or, when no snapshot
 * was stored, its expected path with the digest of zero bytes (evidence/WP-14/decisions.md).
 *
 * @example
 * ledgerSnapshotRef(evidence).artifact_path; // 'trials/<trial_id>/ledger/ledger-snapshot.json'
 */
export function ledgerSnapshotRef(evidence: IngestedEvidence): ArtifactRef {
  const state = subjectArtifactState(evidence, 'ledger_snapshot');
  return state.ref === undefined
    ? { artifact_path: state.path, artifact_sha256: EMPTY_SHA256 }
    : { artifact_path: state.ref.artifact_path, artifact_sha256: state.ref.artifact_sha256 };
}

function sortKey(reason: StructuredReason): string {
  return [reason.subject, reason.code, reason.artifact_path ?? '', reason.event_id ?? '', reason.detail].join('\u0000');
}
