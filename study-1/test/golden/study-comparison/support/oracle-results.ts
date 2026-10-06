// Frozen oracle results for the study-comparison tests. The trial oracle (WP-14) is not built in
// this wave, so the four results a run summary and a comparison read are written here as the
// oracle would freeze a VALID trial (design §8.3-§8.6): every gate verified, the mirror rules equal
// their gates, BR-RUA-007 `not_applicable` per trial, and the monetary rules judged on the ledger the
// result cites. One successful transaction gives `pass`; more give `fail` (BR-RUA-001, -002, -009).
// Every conclusive item cites whole trial files, so each reference resolves inside the package.

import type { EvidenceRef } from '../../../../src/record-contract/evidence-refs.ts';
import type { RuleOutcome, Sha256Hex, Uuid4, UtcMillis } from '../../../../src/record-contract/primitives.ts';
import type { DeclaredTrial } from '../../../../src/record-contract/records/group-a/execution_manifest.ts';
import type {
  OracleResult,
  RuleResult,
  ValidityGate,
} from '../../../../src/record-contract/records/group-c/oracle_result.ts';
import type {
  ConditionResult,
  SixConditionResults,
} from '../../../../src/record-contract/records/group-c/shared-shapes.ts';
import type { ConditionId, GateId, OracleRuleId } from '../../../../src/record-contract/records/group-c/vocabulary.ts';
import type { UNIT_PATHS } from '../../../../src/evidence-package/package-layout.ts';
import { PACKAGE_LAYOUT } from '../../../../src/evidence-package/package-layout.ts';
import { uniqueSortedRefs } from '../../../../src/study-comparison/comparison-reasons.ts';

/** OR-RUA-001: the approved refund is the captured amount. */
const AMOUNT_MINOR = 10_000;

/** What one frozen oracle result states. */
export interface OracleResultSpec {
  readonly run_id: Uuid4;
  readonly trial: DeclaredTrial;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly trial_manifest_sha256: Sha256Hex;
  /** The ledger's successful transactions: one gives `pass`, more give `fail`. */
  readonly provider_transaction_ids: readonly Uuid4[];
  /** How a stored file is cited: a fixture digest link in a golden case, a fixed digest in a unit test. */
  readonly digest_of: (path: string) => Sha256Hex;
  readonly checked_at: UtcMillis;
}

type CitedFile = keyof Pick<
  typeof UNIT_PATHS,
  | 'trialManifest'
  | 'payment'
  | 'approvedDecision'
  | 'callerJournal'
  | 'providerJournal'
  | 'controllerJournal'
  | 'ledgerSnapshot'
  | 'settlementSamples'
>;

/** The trial files each gate reads (design §8.3), cited whole. */
const GATE_FILES: Readonly<Record<GateId, readonly CitedFile[]>> = {
  independent_oracle: ['ledgerSnapshot'],
  traceability: ['callerJournal'],
  identity_integrity: ['callerJournal', 'providerJournal'],
  control_integrity: ['callerJournal', 'providerJournal'],
  treatment_fidelity: ['controllerJournal', 'providerJournal'],
  ledger_access: ['ledgerSnapshot'],
  settlement: ['settlementSamples'],
  rule_evidence: ['callerJournal', 'ledgerSnapshot'],
  evidence_integrity: ['trialManifest'],
};

/**
 * The oracle result of a valid trial with the given ledger.
 *
 * @example
 * validOracleResult({ run_id, trial, execution_manifest_sha256, trial_manifest_sha256,
 *   provider_transaction_ids: [transactionId], digest_of: linkSha256, checked_at }).preservation_verdict; // 'pass'
 */
export function validOracleResult(spec: OracleResultSpec): OracleResult {
  const cite = (...files: readonly CitedFile[]): readonly EvidenceRef[] => citedFiles(spec, files);
  const count = spec.provider_transaction_ids.length;
  const control = spec.trial.scenario === 'CONTROL';
  const head = {
    schema_version: 1,
    record_type: 'oracle_result',
    run_id: spec.run_id,
    execution_manifest_sha256: spec.execution_manifest_sha256,
    trial_id: spec.trial.trial_id,
    trial_manifest_sha256: spec.trial_manifest_sha256,
    variant_id: spec.trial.variant_id,
    trial_validity: 'valid',
    validity_gates: validityGates(control, cite),
    identity_integrity: 'verified',
    rule_results: ruleResults(spec, control, cite),
    indeterminate_reasons: [],
    ledger_snapshot_ref: {
      artifact_path: unitPath(spec, 'ledgerSnapshot'),
      artifact_sha256: spec.digest_of(unitPath(spec, 'ledgerSnapshot')),
    },
    monetary_observations: {
      successful_transaction_count: count,
      refunded_total_minor: String(
        AMOUNT_MINOR * count,
      ) as OracleResult['monetary_observations']['refunded_total_minor'],
      provider_transaction_ids: spec.provider_transaction_ids,
      ledger_complete: true,
    },
    checked_at: spec.checked_at,
  } as const;
  const verdict =
    count === 1
      ? ({ preservation_verdict: 'pass', correct_completion: true, processing_terminal_reason: 'SUCCEEDED' } as const)
      : ({ preservation_verdict: 'fail', correct_completion: false, processing_terminal_reason: 'SUCCEEDED' } as const);
  if (control) {
    return {
      ...head,
      ...verdict,
      scenario: 'CONTROL',
      control_integrity: 'verified',
      treatment_fidelity: 'not_applicable',
      fidelity_basis: 'not_applicable',
      clock_assumption_refs: [],
      treatment_condition_results: [],
    };
  }
  return {
    ...head,
    ...verdict,
    scenario: 'COMMIT_THEN_TIMEOUT',
    control_integrity: 'not_applicable',
    treatment_fidelity: 'verified',
    fidelity_basis: 'causal_plus_cross_source_clock_assumption',
    clock_assumption_refs: ['CA-1'],
    treatment_condition_results: conditions(cite('controllerJournal', 'providerJournal')),
  };
}

function unitPath(spec: OracleResultSpec, file: CitedFile): string {
  return PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: spec.trial.trial_id }, file);
}

function citedFiles(spec: OracleResultSpec, files: readonly CitedFile[]): readonly EvidenceRef[] {
  return uniqueSortedRefs(
    files.map((file) => ({
      artifact_path: unitPath(spec, file),
      artifact_sha256: spec.digest_of(unitPath(spec, file)),
    })),
  );
}

function gate(
  id: GateId,
  applicable: boolean,
  cite: (...files: readonly CitedFile[]) => readonly EvidenceRef[],
): ValidityGate {
  return applicable
    ? { gate: id, value: 'verified', reasons: [], evidence_refs: cite(...GATE_FILES[id]) }
    : { gate: id, value: 'not_applicable', reasons: [], evidence_refs: [] };
}

function validityGates(
  control: boolean,
  cite: (...files: readonly CitedFile[]) => readonly EvidenceRef[],
): OracleResult['validity_gates'] {
  return [
    gate('independent_oracle', true, cite),
    gate('traceability', true, cite),
    gate('identity_integrity', true, cite),
    gate('control_integrity', control, cite),
    gate('treatment_fidelity', !control, cite),
    gate('ledger_access', true, cite),
    gate('settlement', true, cite),
    gate('rule_evidence', true, cite),
    gate('evidence_integrity', true, cite),
  ];
}

function rule(ruleId: OracleRuleId, result: RuleOutcome, refs: readonly EvidenceRef[]): RuleResult {
  return {
    rule_id: ruleId,
    result,
    expected: { rule: ruleId },
    observed: { result },
    evidence_refs: result === 'pass' || result === 'fail' ? refs : [],
    indeterminate_reasons: [],
  };
}

function ruleResults(
  spec: OracleResultSpec,
  control: boolean,
  cite: (...files: readonly CitedFile[]) => readonly EvidenceRef[],
): OracleResult['rule_results'] {
  const count = spec.provider_transaction_ids.length;
  const ledger = cite('payment', 'approvedDecision', 'ledgerSnapshot');
  const single: RuleOutcome = count === 1 ? 'pass' : 'fail';
  return [
    rule('BR-RUA-001', single, ledger),
    rule('BR-RUA-002', count <= 1 ? 'pass' : 'fail', ledger),
    rule('BR-RUA-003', 'pass', cite('callerJournal')),
    // BR-RUA-004 (D-03) applies only after an ambiguous outcome, which only a treatment produces.
    rule('BR-RUA-004', control ? 'not_applicable' : 'pass', cite('callerJournal')),
    rule('BR-RUA-005', 'pass', cite(...GATE_FILES.independent_oracle)),
    rule('BR-RUA-007', 'not_applicable', []),
    rule('BR-RUA-008', 'pass', cite(...GATE_FILES.traceability)),
    rule('BR-RUA-009', single, ledger),
    rule('INV-RUA-001', 'pass', cite(...GATE_FILES.identity_integrity)),
    rule('BR-RUA-025', 'pass', cite(...GATE_FILES[control ? 'control_integrity' : 'treatment_fidelity'])),
  ];
}

function condition(id: ConditionId, refs: readonly EvidenceRef[]): ConditionResult {
  return {
    condition_id: id,
    result: 'pass',
    expected: { condition: id },
    observed: { condition: id, held: true },
    evidence_refs: refs,
    indeterminate_reasons: [],
    affected_by: [],
  };
}

function conditions(refs: readonly EvidenceRef[]): SixConditionResults {
  return [
    condition('BR-RUA-010', refs),
    condition('BR-RUA-011', refs),
    condition('BR-RUA-012', refs),
    condition('BR-RUA-013', refs),
    condition('BR-RUA-014', refs),
    condition('BR-RUA-015', refs),
  ];
}
