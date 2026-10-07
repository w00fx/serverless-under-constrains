// The ingestion input `rua oracle evaluate` re-evaluates one frozen trial from (design §8.2 I3,
// D-16, §11): the trial's frozen input exactly as its freeze composed it, rebuilt by the execution
// lifecycle's own `frozenTrialInput` (evidence/CMP-05/decisions.md: exported so the CLI drops its
// mirror), plus the digest of every path the trial's evidence index froze, so ingestion checks each
// stored byte against the digest frozen for it (I3 `indexed_digests`). This module only finds the
// trial's declared position from the frozen execution manifest and reads the index; every input it
// cannot read is a reason naming the path and the expected shape (A-05: it never throws).

import { readAdmittedExecution } from '../execution-lifecycle/admitted-execution.ts';
import { frozenTrialInput } from '../execution-lifecycle/frozen-trial-input.ts';
import type { IngestionInput } from '../evidence-ingestion/ingestion-model.ts';
import { fileAt } from '../evidence-package/index-entries.ts';
import type { PackageFile } from '../evidence-package/package-file-system.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, Sha256Hex, StructuredReason, Uuid4 } from '../record-contract/primitives.ts';
import type { EvidenceIndex } from '../record-contract/records/group-c/evidence_index.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';

/**
 * The frozen ingestion input of `trialId`, from every file of its package.
 *
 * @example
 * const input = trialEvaluationInput(snapshot.files, trialId, validator);
 * if (input.ok) evaluateTrial({ evidence: ingestEvidence(input.value, validator), checked_at });
 */
export function trialEvaluationInput(
  files: readonly PackageFile[],
  trialId: Uuid4,
  validator: RecordValidator,
): Result<IngestionInput, StructuredReason> {
  const manifestPath = EXECUTION_PATHS.executionManifest;
  const manifestBytes = fileAt(files, manifestPath)?.bytes;
  if (manifestBytes === undefined) {
    return err(inputReason(manifestPath, 'is absent', 'the frozen execution manifest'));
  }
  const admitted = readAdmittedExecution(manifestBytes, validator);
  if (!admitted.ok) {
    return admitted;
  }
  const declared = admitted.value.manifest.trials;
  const position = declared.findIndex((trial) => trial.trial_id === trialId);
  const trial = declared[position];
  if (trial === undefined) {
    const ids = declared.map((candidate) => candidate.trial_id).join(', ');
    return err(inputReason(manifestPath, `declares no trial ${trialId}`, `one of the declared trials [${ids}]`));
  }
  const input = frozenTrialInput(files, trial, declared.slice(0, position), validator);
  if (!input.ok) {
    return input;
  }
  const digests = indexedDigests(files, trialId, validator);
  return digests.ok ? ok({ ...input.value, indexed_digests: digests.value }) : digests;
}

function indexedDigests(
  files: readonly PackageFile[],
  trialId: Uuid4,
  validator: RecordValidator,
): Result<ReadonlyMap<string, Sha256Hex>, StructuredReason> {
  const path = PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: trialId }, 'evidenceIndex');
  const bytes = fileAt(files, path)?.bytes;
  if (bytes === undefined) {
    return err(inputReason(path, 'is absent', "the trial's frozen evidence_index"));
  }
  const parsed = parseJsonDocument(bytes);
  const checked = parsed.ok ? validator.validateAs('evidence_index', parsed.value) : undefined;
  if (checked?.valid !== true) {
    return err(inputReason(path, 'is not a valid record', 'one UTF-8 JSON evidence_index document'));
  }
  const index = checked.record as EvidenceIndex;
  return ok(new Map(index.entries.map((entry) => [entry.artifact_path, entry.sha256])));
}

function inputReason(path: string, problem: string, expected: string): StructuredReason {
  return {
    code: 'FROZEN_TRIAL_INPUT_UNREADABLE',
    subject: 'CTR-RUA-001',
    detail: `${path} ${problem}; expected ${expected}`,
  };
}
