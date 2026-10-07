// The two declared trials of a variant validation as its summary reports them at P9 (BR-RUA-038,
// D-29; design §10.2), read back from the package the runner wrote. A trial that froze an oracle
// result of this trial under this manifest is evaluated, with the digest of its stored bytes, the
// digest of its trial manifest and every way its anchor is not covered (the trial's evidence index
// must list the result with that digest). A trial without one is `incomplete` when its trial
// manifest was frozen (it started, TRIAL_NOT_FROZEN) and `not_started` otherwise. The verifier
// (variant-validation/package-trial-evidence.ts) re-reads the same anchors from the original bytes.

import type { PackageFile } from '../evidence-package/package-file-system.ts';
import { PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import type { EvidenceUnit } from '../evidence-package/package-layout.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import type { Sha256Hex, StructuredReason } from '../record-contract/primitives.ts';
import type { DeclaredTrial } from '../record-contract/records/group-a/execution_manifest.ts';
import type { OracleResult } from '../record-contract/records/group-c/oracle_result.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import type { FrozenRecord } from '../study-comparison/record-files.ts';
import type { OracleResultsByTrial } from '../study-comparison/run-evidence-integrity.ts';
import { readValidationRecord } from '../variant-validation/validation-records.ts';
import type { ValidationManifest, ValidationTrialOutcome } from '../variant-validation/validation-summary.ts';

/** Both declared trials' outcomes, and the oracle results among them for evidence integrity. */
export interface ValidationTrialReading {
  readonly outcomes: readonly [ValidationTrialOutcome, ValidationTrialOutcome];
  readonly oracle_results: OracleResultsByTrial;
}

/**
 * Reads the outcome of each declared trial of `manifest` under `manifestSha256`.
 *
 * @example
 * const { outcomes } = readValidationTrialOutcomes(files, manifest, manifestSha256, validator);
 * outcomes.map((outcome) => outcome.execution_status); // ['completed', 'completed'] after both froze
 */
export function readValidationTrialOutcomes(
  files: readonly PackageFile[],
  manifest: ValidationManifest,
  manifestSha256: Sha256Hex,
  validator: RecordValidator,
): ValidationTrialReading {
  const [control, treatment] = manifest.trials;
  const controlRead = trialOutcome(files, control, manifestSha256, validator);
  const treatmentRead = trialOutcome(files, treatment, manifestSha256, validator);
  const results = [controlRead, treatmentRead].flatMap((read) =>
    read.frozen === undefined ? [] : [[read.frozen.record.trial_id, read.frozen] as const],
  );
  return { outcomes: [controlRead.outcome, treatmentRead.outcome], oracle_results: new Map(results) };
}

interface TrialRead {
  readonly outcome: ValidationTrialOutcome;
  readonly frozen: FrozenRecord<OracleResult> | undefined;
}

function trialOutcome(
  files: readonly PackageFile[],
  declared: DeclaredTrial,
  manifestSha256: Sha256Hex,
  validator: RecordValidator,
): TrialRead {
  const unit: EvidenceUnit = { kind: 'trial', trial_id: declared.trial_id };
  const resultPath = PACKAGE_LAYOUT.unitFile(unit, 'oracleResult');
  const manifestPath = PACKAGE_LAYOUT.unitFile(unit, 'trialManifest');
  const trialManifest = files.find((file) => file.path === manifestPath);
  const read = readValidationRecord(files, resultPath, 'oracle_result', validator);
  const result = read.ok && ownsResult(read.value.record, declared, manifestSha256) ? read.value : undefined;
  if (result === undefined) {
    return { outcome: unevaluated(declared, trialManifest !== undefined), frozen: undefined };
  }
  const ref = { artifact_path: resultPath, artifact_sha256: sha256Hex(result.bytes) };
  return {
    outcome: {
      kind: 'evaluated',
      execution_status: 'completed',
      incompletion_reasons: [],
      oracle_result: result.record,
      oracle_result_ref: ref,
      trial_manifest_sha256: trialManifest === undefined ? undefined : sha256Hex(trialManifest.bytes),
      anchor_problems: anchorProblems(files, unit, ref.artifact_sha256, manifestSha256, validator),
    },
    frozen: { record: result.record, ref },
  };
}

function ownsResult(result: OracleResult, declared: DeclaredTrial, manifestSha256: Sha256Hex): boolean {
  return result.trial_id === declared.trial_id && result.execution_manifest_sha256 === manifestSha256;
}

function unevaluated(declared: DeclaredTrial, started: boolean): ValidationTrialOutcome {
  const unit: EvidenceUnit = { kind: 'trial', trial_id: declared.trial_id };
  const reason: StructuredReason = started
    ? {
        code: 'TRIAL_NOT_FROZEN',
        subject: declared.trial_id,
        artifact_path: PACKAGE_LAYOUT.unitFile(unit, 'oracleResult'),
        detail: `trial ${declared.trial_id} started but froze no oracle result of this trial and manifest; expected a frozen oracle result`,
      }
    : {
        code: 'TRIAL_NOT_STARTED',
        subject: declared.trial_id,
        artifact_path: PACKAGE_LAYOUT.unitFile(unit, 'trialManifest'),
        detail: `trial ${declared.trial_id} has no frozen trial manifest; expected the trial to have started`,
      };
  return {
    kind: 'unevaluated',
    execution_status: started ? 'incomplete' : 'not_started',
    incompletion_reasons: [reason],
  };
}

// The trial's own evidence index must list the stored result with its digest (BR-RUA-044).
function anchorProblems(
  files: readonly PackageFile[],
  unit: Extract<EvidenceUnit, { readonly kind: 'trial' }>,
  resultSha256: Sha256Hex,
  manifestSha256: Sha256Hex,
  validator: RecordValidator,
): readonly string[] {
  const path = PACKAGE_LAYOUT.unitFile(unit, 'evidenceIndex');
  const resultPath = PACKAGE_LAYOUT.unitFile(unit, 'oracleResult');
  const read = readValidationRecord(files, path, 'evidence_index', validator);
  if (!read.ok) {
    return [read.error];
  }
  const index = read.value.record;
  if (
    index.index_scope !== 'TRIAL' ||
    index.trial_id !== unit.trial_id ||
    index.execution_manifest_sha256 !== manifestSha256
  ) {
    return [`${path} is not the evidence index of trial ${unit.trial_id} under manifest ${manifestSha256}`];
  }
  const entry = index.entries.find((candidate) => candidate.artifact_path === resultPath);
  if (entry?.sha256 === resultSha256) {
    return [];
  }
  const listed = entry === undefined ? 'does not list' : `lists digest ${entry.sha256} for`;
  return [`${path} ${listed} ${resultPath}; expected it listed with the stored digest ${resultSha256}`];
}
