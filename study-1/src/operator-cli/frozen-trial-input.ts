// The ingestion input of one frozen trial, rebuilt from its stored package (design §8.2 I3, D-16;
// `rua oracle evaluate`): the trial's own files without what was derived from them (`derived/`
// and its evidence index), the execution-level files that existed when the trial froze, and the
// earlier declared trials' files as the execution scope (INV-RUA-001), as cleanup step 2 composes
// it (`execution-lifecycle/late-evidence-freeze.ts`, private there). Because the package is frozen,
// the trial's evidence index gives the digest of every indexed path, so ingestion checks each
// stored byte against the digest frozen for it (I3 `indexed_digests`). Every input it cannot read
// is a reason naming the path and the expected shape; it never throws on stored bytes (A-05).

import { readAdmittedExecution } from '../execution-lifecycle/admitted-execution.ts';
import type { IngestionInput } from '../evidence-ingestion/ingestion-model.ts';
import { expectedArtifactsFor } from '../evidence-package/expected-artifacts.ts';
import { fileAt } from '../evidence-package/index-entries.ts';
import type { PackageFile } from '../evidence-package/package-file-system.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, Sha256Hex, StructuredReason, Uuid4 } from '../record-contract/primitives.ts';
import type { EvidenceIndex } from '../record-contract/records/group-c/evidence_index.ts';
import type { TrialManifest } from '../record-contract/records/group-a/trial_manifest.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';

// Package areas written after every trial froze: never part of a trial's frozen input.
const WRITTEN_AFTER_FREEZE = ['late-evidence/', 'cleanup/', 'summary/', 'readiness/', 'provider/'];
const TRIALS_PREFIX = 'trials/';

/**
 * The frozen ingestion input of `trialId`, from every file of its package.
 *
 * @example
 * const input = frozenTrialInput(snapshot.files, trialId, validator);
 * if (input.ok) evaluateTrial({ evidence: ingestEvidence(input.value, validator), checked_at });
 */
export function frozenTrialInput(
  files: readonly PackageFile[],
  trialId: Uuid4,
  validator: RecordValidator,
): Result<IngestionInput, StructuredReason> {
  const earlier = earlierTrials(files, trialId, validator);
  if (!earlier.ok) {
    return earlier;
  }
  const unit = { kind: 'trial', trial_id: trialId } as const;
  const manifest = readRecord<TrialManifest>(
    files,
    PACKAGE_LAYOUT.unitFile(unit, 'trialManifest'),
    'trial_manifest',
    validator,
  );
  if (!manifest.ok) {
    return manifest;
  }
  const indexPath = PACKAGE_LAYOUT.unitFile(unit, 'evidenceIndex');
  const index = readRecord<EvidenceIndex>(files, indexPath, 'evidence_index', validator);
  if (!index.ok) {
    return index;
  }
  const subject = `${PACKAGE_LAYOUT.unitDirectory(unit)}/`;
  const derived = [`${subject}derived/`, indexPath];
  const scopes = earlier.value.map((prior) => `${PACKAGE_LAYOUT.unitDirectory({ kind: 'trial', trial_id: prior })}/`);
  return ok({
    artifacts: files.filter(
      (file) =>
        (file.path.startsWith(subject) && !derived.some((prefix) => file.path.startsWith(prefix))) ||
        (!file.path.startsWith(TRIALS_PREFIX) && !WRITTEN_AFTER_FREEZE.some((prefix) => file.path.startsWith(prefix))),
    ),
    expected: expectedArtifactsFor(manifest.value),
    execution_scope_artifacts: files.filter((file) => scopes.some((prefix) => file.path.startsWith(prefix))),
    indexed_digests: new Map<string, Sha256Hex>(
      index.value.entries.map((entry) => [entry.artifact_path, entry.sha256]),
    ),
  });
}

// The trials the execution manifest declares before `trialId`; refused when it declares no such trial.
function earlierTrials(
  files: readonly PackageFile[],
  trialId: Uuid4,
  validator: RecordValidator,
): Result<readonly Uuid4[], StructuredReason> {
  const path = EXECUTION_PATHS.executionManifest;
  const bytes = fileAt(files, path)?.bytes;
  if (bytes === undefined) {
    return err(frozenInputReason(path, 'is absent', 'the frozen execution manifest'));
  }
  const admitted = readAdmittedExecution(bytes, validator);
  if (!admitted.ok) {
    return admitted;
  }
  const declared = admitted.value.manifest.trials.map((trial) => trial.trial_id);
  const position = declared.indexOf(trialId);
  if (position === -1) {
    return err(
      frozenInputReason(path, `declares no trial ${trialId}`, `one of the declared trials [${declared.join(', ')}]`),
    );
  }
  return ok(declared.slice(0, position));
}

function readRecord<T>(
  files: readonly PackageFile[],
  path: string,
  recordType: 'trial_manifest' | 'evidence_index',
  validator: RecordValidator,
): Result<T, StructuredReason> {
  const bytes = fileAt(files, path)?.bytes;
  if (bytes === undefined) {
    return err(frozenInputReason(path, 'is absent', `the trial's frozen ${recordType}`));
  }
  const parsed = parseJsonDocument(bytes);
  const checked = parsed.ok ? validator.validateAs(recordType, parsed.value) : undefined;
  if (checked?.valid !== true) {
    return err(frozenInputReason(path, 'is not a valid record', `one UTF-8 JSON ${recordType} document`));
  }
  return ok(checked.record as T);
}

function frozenInputReason(path: string, problem: string, expected: string): StructuredReason {
  return {
    code: 'FROZEN_TRIAL_INPUT_UNREADABLE',
    subject: 'CTR-RUA-001',
    detail: `${path} ${problem}; expected ${expected}`,
  };
}
