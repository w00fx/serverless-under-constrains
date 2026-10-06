// The scientific evidence of a variant-validation package as the verifier reads it back from the
// original bytes (BR-RUA-038, BR-RUA-044; design §8.15). Per declared trial, in declared order:
// - the summary entry must be the declared trial (same sequence, id, variant, scenario), and the
//   summary must name the frozen manifest and variant: anything else is manifest drift;
// - an entry without an oracle result, or an oracle result that cannot be read at
//   `trials/<t>/derived/oracle-result.json`, is missing scientific evidence;
// - the trial manifest must be readable and must be this trial of this manifest (drift otherwise);
// - the result must be covered by its cryptographic anchors: the summary's `oracle_result_ref`
//   names the result's path and the digest of its stored bytes, and the trial's evidence index is
//   this trial's index of this manifest and lists the result with that same digest.
// What the judged values mean is decided in scientific-evidence.ts; this module only reads.

import type { Sha256Hex } from '../record-contract/primitives.ts';
import type { DeclaredTrial } from '../record-contract/records/group-a/execution_manifest.ts';
import type { TrialManifest } from '../record-contract/records/group-a/trial_manifest.ts';
import type { SummaryTrialResult } from '../record-contract/records/group-c/shared-shapes.ts';
import type { ValidationSummary } from '../record-contract/records/group-c/validation_summary.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import type { PackageFile } from '../evidence-package/package-file-system.ts';
import type { ByteDigest } from '../evidence-package/package-integrity.ts';
import { PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import type { AdmissionEvidence } from './admission-evidence.ts';
import type { ScientificEvidence, TrialEvidence } from './scientific-evidence.ts';
import { readValidationRecord } from './validation-records.ts';
import { validationReason } from './validation-reasons.ts';
import type { ValidationReason } from './validation-reasons.ts';

export interface PackageTrialEvidenceInput {
  readonly files: readonly PackageFile[];
  readonly admission: AdmissionEvidence;
  readonly summary: ValidationSummary;
}

/** The services the reader uses. */
export interface PackageTrialEvidenceDeps {
  readonly validator: RecordValidator;
  readonly digest: ByteDigest;
}

interface TrialRead {
  readonly evidence: TrialEvidence;
  readonly defects: readonly ValidationReason[];
}

/**
 * Reads the scientific evidence of both declared trials, with the admission defects and every
 * drift found between the manifest, the summary and the trial manifests.
 *
 * @example
 * const evidence = readPackageTrialEvidence({ files, admission, summary }, { validator, digest: sha256Hex });
 * assessScientificEvidence(evidence).validation_validity; // 'valid' for a sound package
 */
export function readPackageTrialEvidence(
  input: PackageTrialEvidenceInput,
  deps: PackageTrialEvidenceDeps,
): ScientificEvidence {
  const { manifest, execution_manifest_sha256: manifestDigest } = input.admission;
  const [control, treatment] = manifest.trials;
  const [controlEntry, treatmentEntry] = input.summary.trial_results;
  const controlRead = readTrial(input, control, controlEntry, deps);
  const treatmentRead = readTrial(input, treatment, treatmentEntry, deps);
  return {
    variant_validation_id: manifest.variant_validation_id,
    variant_id: manifest.variant_id,
    execution_manifest_sha256: manifestDigest,
    trials: [controlRead.evidence, treatmentRead.evidence],
    defects: [
      ...input.admission.defects,
      ...summaryDrift(input.summary, input.admission),
      ...controlRead.defects,
      ...treatmentRead.defects,
    ],
  };
}

function summaryDrift(summary: ValidationSummary, admission: AdmissionEvidence): readonly ValidationReason[] {
  const { manifest } = admission;
  const problems = [
    ...(summary.execution_manifest_sha256 === admission.execution_manifest_sha256
      ? []
      : [
          `names execution_manifest_sha256 ${summary.execution_manifest_sha256}, not ${admission.execution_manifest_sha256}`,
        ]),
    ...(summary.variant_id === manifest.variant_id
      ? []
      : [`names variant ${summary.variant_id}, not ${manifest.variant_id}`]),
  ];
  return problems.map((problem) => drift('validation summary', `the summary ${problem}`));
}

function readTrial(
  input: PackageTrialEvidenceInput,
  declared: DeclaredTrial,
  entry: SummaryTrialResult,
  deps: PackageTrialEvidenceDeps,
): TrialRead {
  const subject = `trial ${String(declared.sequence)} (${declared.scenario})`;
  const manifestRead = readTrialManifest(input, declared, deps);
  const defects = [...entryDrift(subject, declared, entry), ...manifestRead.defects];
  const resultPath = PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: declared.trial_id }, 'oracleResult');
  if (!('oracle_result_ref' in entry)) {
    const detail = `the summary records trial ${declared.trial_id} as ${entry.execution_status} without an oracle result; expected a frozen oracle result`;
    return { evidence: { kind: 'missing', declared, artifact_path: resultPath, detail }, defects };
  }
  const result = readValidationRecord(input.files, resultPath, 'oracle_result', deps.validator);
  if (!result.ok) {
    return { evidence: { kind: 'missing', declared, artifact_path: resultPath, detail: result.error }, defects };
  }
  const resultDigest = deps.digest(result.value.bytes);
  const refProblems =
    entry.oracle_result_ref.artifact_path === resultPath && entry.oracle_result_ref.artifact_sha256 === resultDigest
      ? []
      : [
          `the summary's oracle_result_ref names ${entry.oracle_result_ref.artifact_path} ${entry.oracle_result_ref.artifact_sha256}; expected ${resultPath} ${resultDigest}`,
        ];
  return {
    evidence: {
      kind: 'frozen',
      declared,
      oracle_result: result.value.record,
      trial_manifest_sha256: manifestRead.sha256,
      anchor_problems: [...refProblems, ...indexProblems(input, declared, resultPath, resultDigest, deps)],
    },
    defects,
  };
}

function entryDrift(subject: string, declared: DeclaredTrial, entry: SummaryTrialResult): readonly ValidationReason[] {
  return headText(entry) === headText(declared)
    ? []
    : [drift(subject, `the summary entry is ${headText(entry)}; expected ${headText(declared)}`)];
}

function readTrialManifest(
  input: PackageTrialEvidenceInput,
  declared: DeclaredTrial,
  deps: PackageTrialEvidenceDeps,
): { readonly sha256: Sha256Hex | undefined; readonly defects: readonly ValidationReason[] } {
  const path = PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: declared.trial_id }, 'trialManifest');
  const read = readValidationRecord(input.files, path, 'trial_manifest', deps.validator);
  if (!read.ok) {
    return { sha256: undefined, defects: [] };
  }
  const problem = trialManifestProblem(read.value.record, declared, input.admission);
  return {
    sha256: deps.digest(read.value.bytes),
    defects:
      problem === undefined ? [] : [drift(`trial ${String(declared.sequence)} (${declared.scenario})`, problem, path)],
  };
}

function trialManifestProblem(
  trial: TrialManifest,
  declared: DeclaredTrial,
  admission: AdmissionEvidence,
): string | undefined {
  if (trial.execution_manifest_sha256 !== admission.execution_manifest_sha256) {
    return `the trial manifest names execution_manifest_sha256 ${trial.execution_manifest_sha256}; expected ${admission.execution_manifest_sha256}`;
  }
  if (trial.variant_validation_id !== admission.manifest.variant_validation_id) {
    return `the trial manifest belongs to execution ${trial.variant_validation_id ?? `run ${String(trial.run_id)}`}; expected validation ${admission.manifest.variant_validation_id}`;
  }
  return headText(trial) === headText(declared)
    ? undefined
    : `the trial manifest is ${headText(trial)}; expected ${headText(declared)}`;
}

function indexProblems(
  input: PackageTrialEvidenceInput,
  declared: DeclaredTrial,
  resultPath: string,
  resultDigest: Sha256Hex,
  deps: PackageTrialEvidenceDeps,
): readonly string[] {
  const path = PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: declared.trial_id }, 'evidenceIndex');
  const read = readValidationRecord(input.files, path, 'evidence_index', deps.validator);
  if (!read.ok) {
    return [read.error];
  }
  const index = read.value.record;
  const ownIndex =
    index.index_scope === 'TRIAL' &&
    index.trial_id === declared.trial_id &&
    index.variant_validation_id === input.admission.manifest.variant_validation_id &&
    index.execution_manifest_sha256 === input.admission.execution_manifest_sha256;
  if (!ownIndex) {
    return [`${path} is not the evidence index of trial ${declared.trial_id} of this validation's manifest`];
  }
  const entry = index.entries.find((candidate) => candidate.artifact_path === resultPath);
  if (entry?.sha256 === resultDigest) {
    return [];
  }
  const listed = entry === undefined ? 'does not list' : `lists digest ${entry.sha256} for`;
  return [`${path} ${listed} ${resultPath}; expected it listed with the stored digest ${resultDigest}`];
}

function headText(head: Pick<DeclaredTrial, 'sequence' | 'trial_id' | 'variant_id' | 'scenario'>): string {
  return `${String(head.sequence)}/${head.trial_id}/${head.variant_id}/${head.scenario}`;
}

function drift(subject: string, problem: string, artifactPath?: string): ValidationReason {
  return validationReason('MANIFEST_DRIFT', subject, `${problem}; expected the frozen manifest's value`, artifactPath);
}
