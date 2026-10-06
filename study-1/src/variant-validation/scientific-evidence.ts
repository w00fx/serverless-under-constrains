// The scientific acceptance conditions of a variant validation (BR-RUA-038; design §8.15): what the
// original frozen evidence of the two declared trials says, independent of operational closure.
// Operational recovery can never repair any of them (AC-RUA-037): a missing or non-valid trial
// result, control integrity or treatment fidelity other than `verified`, an indeterminate control
// or treatment verdict, invalid admission, manifest drift, or a missing cryptographic anchor.
//
// `validation_validity` folds the trials' BR-RUA-029 validities with the same precedence a trial
// uses for its gates (invalid > indeterminate > valid). Invalid admission and manifest drift make
// the validation `invalid` (a record that resolves to another manifest is untraceable, as design
// §8.3 G2 judges it); missing evidence and a missing anchor make it `indeterminate`
// (evidence/WP-17/decisions.md).

import type { Sha256Hex, Uuid4, VariantId } from '../record-contract/primitives.ts';
import type { DeclaredTrial } from '../record-contract/records/group-a/execution_manifest.ts';
import type { OracleResult } from '../record-contract/records/group-c/oracle_result.ts';
import type { PreservationVerdict, TrialValidity } from '../record-contract/records/group-c/vocabulary.ts';
import { validationReason } from './validation-reasons.ts';
import type { ValidationReason, ValidationReasonCode } from './validation-reasons.ts';

/** One declared trial whose oracle result could not be read: missing scientific evidence. */
export interface MissingTrialEvidence {
  readonly kind: 'missing';
  readonly declared: DeclaredTrial;
  /** The artifact that is absent or unreadable. */
  readonly artifact_path: string;
  readonly detail: string;
}

/** One declared trial with its frozen oracle result. */
export interface FrozenTrialEvidence {
  readonly kind: 'frozen';
  readonly declared: DeclaredTrial;
  readonly oracle_result: OracleResult;
  /** Digest of the stored trial-manifest bytes; `undefined` when the trial manifest is missing. */
  readonly trial_manifest_sha256: Sha256Hex | undefined;
  /** Why the result is not covered by its cryptographic anchors; empty when it is. */
  readonly anchor_problems: readonly string[];
}

export type TrialEvidence = MissingTrialEvidence | FrozenTrialEvidence;

/** Everything the scientific conditions read. */
export interface ScientificEvidence {
  readonly variant_validation_id: Uuid4;
  readonly variant_id: VariantId;
  /** Digest of the frozen execution manifest. */
  readonly execution_manifest_sha256: Sha256Hex;
  /** The CONTROL trial, then the COMMIT_THEN_TIMEOUT trial (BR-RUA-038 order). */
  readonly trials: readonly [TrialEvidence, TrialEvidence];
  /** Defects found outside the two trials (admission, summary drift), each a scientific reason. */
  readonly defects: readonly ValidationReason[];
}

/** The scientific half of a status derivation. */
export interface ScientificAssessment {
  readonly validation_validity: TrialValidity;
  readonly reasons: readonly ValidationReason[];
  /** `undefined` when the trial has no readable oracle result. */
  readonly control_verdict: PreservationVerdict | undefined;
  readonly treatment_verdict: PreservationVerdict | undefined;
}

const INVALIDATING: ReadonlySet<ValidationReasonCode> = new Set(['ADMISSION_INVALID', 'MANIFEST_DRIFT']);
const UNRESOLVED: ReadonlySet<ValidationReasonCode> = new Set([
  'SCIENTIFIC_EVIDENCE_MISSING',
  'CRYPTOGRAPHIC_ANCHOR_MISSING',
]);

/**
 * Judges the scientific conditions of a validation's original evidence.
 *
 * @example
 * const science = assessScientificEvidence({ variant_validation_id, variant_id: 'durable',
 *   execution_manifest_sha256, trials: [controlEvidence, treatmentEvidence], defects: [] });
 * science.validation_validity; // 'valid' for two valid, anchored, drift-free results
 */
export function assessScientificEvidence(evidence: ScientificEvidence): ScientificAssessment {
  const [control, treatment] = evidence.trials;
  const reasons = [...evidence.defects, ...trialReasons(evidence, control), ...trialReasons(evidence, treatment)];
  const validities = [
    trialValidityOf(control),
    trialValidityOf(treatment),
    ...reasons.map((reason) => validityOfReason(reason.code)),
  ];
  return {
    validation_validity: foldValidity(validities),
    reasons,
    control_verdict: verdictOf(control),
    treatment_verdict: verdictOf(treatment),
  };
}

function trialReasons(evidence: ScientificEvidence, trial: TrialEvidence): readonly ValidationReason[] {
  const subject = `trial ${String(trial.declared.sequence)} (${trial.declared.scenario})`;
  if (trial.kind === 'missing') {
    return [validationReason('SCIENTIFIC_EVIDENCE_MISSING', subject, trial.detail, trial.artifact_path)];
  }
  const result = trial.oracle_result;
  return [
    ...manifestReasons(subject, trial),
    ...driftReasons(subject, evidence, trial).map((problem) =>
      validationReason('MANIFEST_DRIFT', subject, `${problem}; expected the frozen manifest's value`),
    ),
    ...trial.anchor_problems.map((problem) => validationReason('CRYPTOGRAPHIC_ANCHOR_MISSING', subject, problem)),
    ...(result.trial_validity === 'valid'
      ? []
      : [validationReason('TRIAL_NOT_VALID', subject, `trial_validity is ${result.trial_validity}; expected valid`)]),
    ...scenarioReasons(subject, trial.declared, result),
  ];
}

function manifestReasons(subject: string, trial: FrozenTrialEvidence): readonly ValidationReason[] {
  return trial.trial_manifest_sha256 === undefined
    ? [
        validationReason(
          'SCIENTIFIC_EVIDENCE_MISSING',
          subject,
          `the trial manifest of trial ${trial.declared.trial_id} is absent or unreadable; expected the frozen trial manifest`,
        ),
      ]
    : [];
}

function driftReasons(subject: string, evidence: ScientificEvidence, trial: FrozenTrialEvidence): readonly string[] {
  const result = trial.oracle_result;
  const { declared } = trial;
  const problems: string[] = [];
  if (result.execution_manifest_sha256 !== evidence.execution_manifest_sha256) {
    problems.push(
      `execution_manifest_sha256 is ${result.execution_manifest_sha256}, not ${evidence.execution_manifest_sha256}`,
    );
  }
  if (result.variant_validation_id !== evidence.variant_validation_id) {
    problems.push(
      `the result names execution ${result.variant_validation_id ?? `run ${String(result.run_id)}`}, not validation ${evidence.variant_validation_id}`,
    );
  }
  if (
    result.trial_id !== declared.trial_id ||
    result.variant_id !== declared.variant_id ||
    result.scenario !== declared.scenario
  ) {
    problems.push(
      `${subject} result is ${result.trial_id}/${result.variant_id}/${result.scenario}, not ${declared.trial_id}/${declared.variant_id}/${declared.scenario}`,
    );
  }
  if (trial.trial_manifest_sha256 !== undefined && result.trial_manifest_sha256 !== trial.trial_manifest_sha256) {
    problems.push(`trial_manifest_sha256 is ${result.trial_manifest_sha256}, not ${trial.trial_manifest_sha256}`);
  }
  return problems;
}

function scenarioReasons(subject: string, declared: DeclaredTrial, result: OracleResult): readonly ValidationReason[] {
  const control = declared.scenario === 'CONTROL';
  const condition = control ? result.control_integrity : result.treatment_fidelity;
  const conditionReasons =
    condition === 'verified'
      ? []
      : [
          validationReason(
            control ? 'CONTROL_INTEGRITY_NOT_VERIFIED' : 'TREATMENT_FIDELITY_NOT_VERIFIED',
            subject,
            `${control ? 'control_integrity' : 'treatment_fidelity'} is ${condition}; expected verified`,
          ),
        ];
  const verdictReasons =
    result.preservation_verdict === 'indeterminate'
      ? [
          validationReason(
            control ? 'CONTROL_VERDICT_INDETERMINATE' : 'TREATMENT_VERDICT_INDETERMINATE',
            subject,
            'preservation_verdict is indeterminate; expected a conclusive pass or fail',
          ),
        ]
      : [];
  return [...conditionReasons, ...verdictReasons];
}

function trialValidityOf(trial: TrialEvidence): TrialValidity {
  return trial.kind === 'missing' ? 'indeterminate' : trial.oracle_result.trial_validity;
}

function validityOfReason(code: ValidationReasonCode): TrialValidity {
  if (INVALIDATING.has(code)) {
    return 'invalid';
  }
  return UNRESOLVED.has(code) ? 'indeterminate' : 'valid';
}

function foldValidity(validities: readonly TrialValidity[]): TrialValidity {
  if (validities.includes('invalid')) {
    return 'invalid';
  }
  return validities.includes('indeterminate') ? 'indeterminate' : 'valid';
}

function verdictOf(trial: TrialEvidence): PreservationVerdict | undefined {
  return trial.kind === 'missing' ? undefined : trial.oracle_result.preservation_verdict;
}
