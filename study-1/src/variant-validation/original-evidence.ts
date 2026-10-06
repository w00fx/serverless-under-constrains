// What the CTR-RUA-004 verifier reads from the original bytes of a validation package, once
// (BR-RUA-038, BR-RUA-043, BR-RUA-046; design §8.15): the admission and the scientific evidence of
// both declared trials, the stored oracle results that evidence was read from, and the safety and
// late-evidence assessments of this validation. The summary is the writer's claim about these
// records; the status derivations read the records, and the verifier compares the claim with them.
//
// An assessment that cannot be read, or that belongs to another execution or manifest, is kept as
// its problem text: the verifier turns it into unverified safety or unverified late evidence and
// names the problem when the summary claims otherwise.

import type { Uuid4 } from '../record-contract/primitives.ts';
import type { Result } from '../record-contract/primitives.ts';
import type { LateEvidenceAssessment } from '../record-contract/records/group-c/late_evidence_assessment.ts';
import type { SafetyAssessment } from '../record-contract/records/group-c/safety_assessment.ts';
import type { ArtifactRef } from '../record-contract/records/group-c/shared-shapes.ts';
import type { ValidationSummary } from '../record-contract/records/group-c/validation_summary.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import type { PackageFile } from '../evidence-package/package-file-system.ts';
import type { ByteDigest } from '../evidence-package/package-integrity.ts';
import { EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import { readAdmissionEvidence } from './admission-evidence.ts';
import { readPackageTrialEvidence } from './package-trial-evidence.ts';
import { assessScientificEvidence } from './scientific-evidence.ts';
import type { ScientificAssessment, ScientificEvidence } from './scientific-evidence.ts';
import { readOwnValidationRecord } from './validation-records.ts';
import type { ValidationRecordOwner } from './validation-records.ts';

export interface OriginalEvidenceInput {
  readonly files: readonly PackageFile[];
  readonly variant_validation_id: Uuid4;
  /** The summary read from the same package; it names the trials' oracle-result references. */
  readonly summary: ValidationSummary;
}

/** The services the reader uses. */
export interface OriginalEvidenceDeps {
  readonly validator: RecordValidator;
  readonly digest: ByteDigest;
}

export interface OriginalEvidence {
  readonly scientific: ScientificAssessment;
  /** The stored oracle results the scientific evidence was read from, each listed once. */
  readonly result_refs: readonly ArtifactRef[];
  /** This validation's safety assessment, or why there is none. */
  readonly safety: Result<SafetyAssessment, string>;
  /** This validation's late-evidence assessment, or why there is none. */
  readonly late_evidence: Result<LateEvidenceAssessment, string>;
}

/**
 * Reads the original evidence of a validation package. Total over arbitrary bytes: every defect is
 * a reason or a problem text, never a throw.
 *
 * @example
 * const original = readOriginalEvidence({ files, variant_validation_id, summary }, { validator, digest: sha256Hex });
 * original.scientific.validation_validity; // 'valid' for a sound package
 * original.late_evidence.ok && original.late_evidence.value.late_evidence_status; // 'none'
 */
export function readOriginalEvidence(input: OriginalEvidenceInput, deps: OriginalEvidenceDeps): OriginalEvidence {
  const { files, summary, variant_validation_id: validationId } = input;
  const admission = readAdmissionEvidence(files, validationId, deps);
  if (!admission.ok) {
    // Without a readable manifest of this validation, the summary's digest is the only manifest
    // the assessments can be held to; the validation is invalid admission either way.
    const owner = { variant_validation_id: validationId, execution_manifest_sha256: summary.execution_manifest_sha256 };
    return {
      scientific: {
        validation_validity: 'invalid',
        reasons: [admission.error],
        control_verdict: undefined,
        treatment_verdict: undefined,
      },
      result_refs: [],
      ...assessmentsOf(files, owner, deps.validator),
    };
  }
  const evidence = readPackageTrialEvidence({ files, admission: admission.value, summary }, deps);
  const owner = {
    variant_validation_id: validationId,
    execution_manifest_sha256: admission.value.execution_manifest_sha256,
  };
  return {
    scientific: assessScientificEvidence(evidence),
    result_refs: resultRefs(evidence),
    ...assessmentsOf(files, owner, deps.validator),
  };
}

function assessmentsOf(
  files: readonly PackageFile[],
  owner: ValidationRecordOwner,
  validator: RecordValidator,
): Pick<OriginalEvidence, 'safety' | 'late_evidence'> {
  return {
    safety: readOwnValidationRecord(files, EXECUTION_PATHS.safetyAssessment, 'safety_assessment', owner, validator),
    late_evidence: readOwnValidationRecord(
      files,
      EXECUTION_PATHS.lateEvidenceAssessment,
      'late_evidence_assessment',
      owner,
      validator,
    ),
  };
}

// A manifest may declare one trial id twice (the schema pins sequence and scenario only), so two
// declared trials can read one stored result; a reference list never repeats (BR-RUA-035).
function resultRefs(evidence: ScientificEvidence): readonly ArtifactRef[] {
  const refs = evidence.trials.flatMap((trial) => (trial.kind === 'frozen' ? [trial.oracle_result_ref] : []));
  return refs.filter(
    (ref, position) => refs.findIndex((other) => other.artifact_path === ref.artifact_path) === position,
  );
}
