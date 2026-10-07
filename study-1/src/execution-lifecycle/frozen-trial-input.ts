// The frozen evidence of a run's or variant validation's trials, rebuilt from the package exactly as
// each trial freeze composed it (design §8.13, §10.2 T11; BR-RUA-043): the trial's own files minus
// its derived results and evidence index, the execution-level files that existed at freeze, and the
// earlier trials' files as execution scope. The late-evidence assessment re-evaluates this input,
// and `oracle evaluate` re-derives a stored result from it (evidence/CMP-05/decisions.md: exported
// so the operator CLI drops its mirror). Pure: it only reads the given files.
//
// The runner journal has grown since the freeze (later trials, cleanup, summary phases); that
// matters only to digests, never to the verdict projection the reassessment compares (D-16).

import type { IngestionInput } from '../evidence-ingestion/ingestion-model.ts';
import { expectedArtifactsFor } from '../evidence-package/expected-artifacts.ts';
import type { PackageFile } from '../evidence-package/package-file-system.ts';
import { PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import type { DeclaredTrial, ExecutionManifest } from '../record-contract/records/group-a/execution_manifest.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { readRecordFile } from '../study-comparison/record-files.ts';
import type { FrozenTrialEvidence } from '../trial-oracle/late-evidence/late-evidence-input.ts';
import { filesByPath } from './execution-package.ts';

/** Package areas written after every unit froze: never part of a trial's or the probe's frozen input. */
export const WRITTEN_AFTER_FREEZE: readonly string[] = [
  'late-evidence/',
  'cleanup/',
  'summary/',
  'readiness/',
  'provider/',
];

/**
 * Every declared trial that froze an oracle result, in declared order, with the evidence it was
 * derived from; or every reason a frozen trial's input cannot be rebuilt.
 *
 * @example
 * const trials = frozenTrialEvidence(files, admitted.manifest, validator);
 * if (trials.ok) trials.value.map((trial) => trial.result.path); // ['trials/<id>/derived/oracle-result.json', …]
 */
export function frozenTrialEvidence(
  files: readonly PackageFile[],
  manifest: ExecutionManifest,
  validator: RecordValidator,
): Result<readonly FrozenTrialEvidence[], readonly StructuredReason[]> {
  const byPath = filesByPath(files);
  const trials = manifest.trials;
  const evidence: FrozenTrialEvidence[] = [];
  const reasons: StructuredReason[] = [];
  for (const [index, trial] of trials.entries()) {
    const path = PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: trial.trial_id }, 'oracleResult');
    const bytes = byPath.get(path);
    if (bytes === undefined) {
      continue;
    }
    const input = frozenTrialInput(files, trial, trials.slice(0, index), validator);
    if (!input.ok) {
      reasons.push(input.error);
      continue;
    }
    evidence.push({ frozen: input.value, result: { path, bytes } });
  }
  return reasons.length > 0 ? err(reasons) : ok(evidence);
}

/**
 * The ingestion input one trial's freeze evaluated: its files, the execution-level files that
 * existed then, and the earlier trials as execution scope; or why its trial manifest cannot be read.
 *
 * @example
 * const input = frozenTrialInput(files, manifest.trials[1], manifest.trials.slice(0, 1), validator);
 * if (input.ok) ingestEvidence(input.value, validator);
 */
export function frozenTrialInput(
  files: readonly PackageFile[],
  trial: DeclaredTrial,
  earlier: readonly DeclaredTrial[],
  validator: RecordValidator,
): Result<IngestionInput, StructuredReason> {
  const unit = { kind: 'trial', trial_id: trial.trial_id } as const;
  const manifestPath = PACKAGE_LAYOUT.unitFile(unit, 'trialManifest');
  const manifest = readRecordFile(filesByPath(files), manifestPath, 'trial_manifest', {
    validator,
    digest: sha256Hex,
  });
  if (manifest.status !== 'read') {
    const why = manifest.status === 'absent' ? `${manifestPath} is absent` : manifest.reason.detail;
    return err(
      frozenInputReason(
        'FROZEN_TRIAL_INPUT_UNREADABLE',
        `${why}; expected the trial manifest its oracle result was derived from`,
      ),
    );
  }
  const subject = `${PACKAGE_LAYOUT.unitDirectory(unit)}/`;
  const derived = [`${subject}derived/`, PACKAGE_LAYOUT.unitFile(unit, 'evidenceIndex')];
  const scopes = earlier.map(
    (prior) => `${PACKAGE_LAYOUT.unitDirectory({ kind: 'trial', trial_id: prior.trial_id })}/`,
  );
  return ok({
    artifacts: files.filter(
      (file) =>
        (file.path.startsWith(subject) && !derived.some((prefix) => file.path.startsWith(prefix))) ||
        (!file.path.startsWith('trials/') && !writtenAfterFreeze(file.path)),
    ),
    expected: expectedArtifactsFor(manifest.frozen.record),
    execution_scope_artifacts: files.filter((file) => scopes.some((prefix) => file.path.startsWith(prefix))),
  });
}

/**
 * Whether a package path lies in an area written after every unit froze.
 *
 * @example
 * writtenAfterFreeze('cleanup/cleanup-result.json'); // true
 */
export function writtenAfterFreeze(path: string): boolean {
  return WRITTEN_AFTER_FREEZE.some((prefix) => path.startsWith(prefix));
}

/**
 * A structured reason of the late-evidence steps (BR-RUA-043).
 *
 * @example
 * frozenInputReason('FROZEN_TRIAL_INPUT_UNREADABLE', 'trials/<id>/trial-manifest.json is absent; expected …');
 */
export function frozenInputReason(code: string, detail: string): StructuredReason {
  return { code, subject: 'BR-RUA-043', detail };
}
