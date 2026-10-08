// Typed inputs of the pure variant-validation derivations: declared trials, frozen trial evidence
// built from the catalogue's oracle-result examples (re-identified into one validation), and safety
// assessments. Nothing here touches a package; the package readers have their own tests.

import type { EvidenceRef } from '../../../../src/record-contract/evidence-refs.ts';
import type { Sha256Hex } from '../../../../src/record-contract/primitives.ts';
import type { DeclaredTrial } from '../../../../src/record-contract/records/group-a/execution_manifest.ts';
import type { SafetyBoundary, SafetyResult } from '../../../../src/record-contract/records/group-b/vocabulary.ts';
import type { OracleResult } from '../../../../src/record-contract/records/group-c/oracle_result.ts';
import type {
  SafetyAssessment,
  SafetyCheck,
} from '../../../../src/record-contract/records/group-c/safety_assessment.ts';
import type {
  FrozenTrialEvidence,
  ScientificEvidence,
} from '../../../../src/variant-validation/scientific-evidence.ts';
import {
  controlPassOracleResult,
  treatmentPassOracleResult,
} from '../../../contract/record-contract/group-c/examples/oracle-examples.ts';
import { VALIDATION_ID, at, digest, uuid } from '../../../support/record-contract/record-builders.ts';

export const MANIFEST_DIGEST: Sha256Hex = digest('validation execution manifest');
export const DECLARED_CONTROL: DeclaredTrial = {
  sequence: 1,
  trial_id: uuid(0x1901),
  variant_id: 'durable',
  scenario: 'CONTROL',
};
export const DECLARED_TREATMENT: DeclaredTrial = {
  sequence: 2,
  trial_id: uuid(0x1902),
  variant_id: 'durable',
  scenario: 'COMMIT_THEN_TIMEOUT',
};

/**
 * The trial-manifest digest a frozen trial of these tests carries.
 *
 * @example
 * trialManifestDigest(DECLARED_CONTROL);
 */
export function trialManifestDigest(trial: DeclaredTrial): Sha256Hex {
  return digest(`trial manifest ${trial.trial_id}`);
}

/**
 * An oracle-result example moved into the validation's declared trial.
 *
 * @example
 * inValidation(controlPassOracleResult(), DECLARED_CONTROL).trial_id; // DECLARED_CONTROL.trial_id
 */
export function inValidation(example: OracleResult, trial: DeclaredTrial): OracleResult {
  const { run_id: _runId, variant_validation_id: _validationId, ...rest } = example;
  const moved = {
    ...rest,
    variant_validation_id: VALIDATION_ID,
    execution_manifest_sha256: MANIFEST_DIGEST,
    trial_id: trial.trial_id,
    trial_manifest_sha256: trialManifestDigest(trial),
    variant_id: trial.variant_id,
    scenario: trial.scenario,
  };
  // The examples are valid oracle results; only their identity members change here.
  return moved as unknown as OracleResult;
}

/**
 * Frozen evidence of a declared trial, from a result (by default the trial's `pass` example).
 *
 * @example
 * frozen(DECLARED_TREATMENT, { anchor_problems: ['no evidence index'] });
 */
export function frozen(trial: DeclaredTrial, overrides: Partial<FrozenTrialEvidence> = {}): FrozenTrialEvidence {
  const example = trial.scenario === 'CONTROL' ? controlPassOracleResult() : treatmentPassOracleResult();
  return {
    kind: 'frozen',
    declared: trial,
    oracle_result: inValidation(example, trial),
    oracle_result_ref: {
      artifact_path: `trials/${trial.trial_id}/derived/oracle-result.json`,
      artifact_sha256: digest(`oracle result ${trial.trial_id}`),
    },
    trial_manifest_sha256: trialManifestDigest(trial),
    anchor_problems: [],
    ...overrides,
  };
}

/**
 * Sound scientific evidence of both trials, with optional overrides.
 *
 * @example
 * scientificEvidence({ defects: [admissionReason] });
 */
export function scientificEvidence(overrides: Partial<ScientificEvidence> = {}): ScientificEvidence {
  return {
    variant_validation_id: VALIDATION_ID,
    variant_id: 'durable',
    execution_manifest_sha256: MANIFEST_DIGEST,
    trials: [frozen(DECLARED_CONTROL), frozen(DECLARED_TREATMENT)],
    defects: [],
    ...overrides,
  };
}

const REF: EvidenceRef = { artifact_path: 'runner/runner-journal.jsonl', artifact_sha256: digest('runner journal') };

/**
 * One safety check of a boundary with a result.
 *
 * @example
 * safetyCheck('BILLED_COST', 'unverified');
 */
export function safetyCheck(boundary: SafetyBoundary, result: SafetyResult): SafetyCheck {
  const observed = result === 'unverified' ? {} : { observed: '1 unit' };
  return {
    boundary,
    declared_limit: '2 units',
    ...observed,
    result,
    evidence_refs: result === 'unverified' ? [] : [REF],
    checked_at: at(4000),
  };
}

/** The OR-RUA-005 real-time safeguards, each within limits. */
export const SAFEGUARDS_WITHIN_LIMITS: readonly SafetyCheck[] = [
  safetyCheck('ESTIMATED_COST', 'within_limits'),
  safetyCheck('ACTIVE_TIME', 'within_limits'),
  safetyCheck('TOTAL_TIME', 'within_limits'),
];

/**
 * A safety assessment of the validation.
 *
 * @example
 * safetyAssessment('within_limits', SAFEGUARDS_WITHIN_LIMITS);
 */
export function safetyAssessment(status: SafetyResult, checks: readonly SafetyCheck[]): SafetyAssessment {
  const [first, ...rest] = checks;
  if (first === undefined) {
    throw new Error('a safety assessment with no check; expected at least one check');
  }
  return {
    schema_version: 1,
    record_type: 'safety_assessment',
    variant_validation_id: VALIDATION_ID,
    execution_manifest_sha256: MANIFEST_DIGEST,
    safety_status: status,
    checks: [first, ...rest],
    reasons: [],
    assessed_at: at(8900),
  };
}
