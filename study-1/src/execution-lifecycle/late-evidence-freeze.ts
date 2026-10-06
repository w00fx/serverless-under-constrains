// Cleanup steps 1 and 2 of a run or a variant validation (design §10.4; BR-RUA-043, BR-RUA-048,
// BR-RUA-049; AC-RUA-030): step 1 completes the late-evidence cutoff by writing the late stream
// observed during monitoring; step 2 freezes `late-evidence/late-evidence-assessment.json` from the
// stream, how monitoring ended and every frozen oracle result. Monitoring that was skipped or
// shortened leaves late evidence `unverified`.
//
// No late-record capture is bound in this feature (evidence/WP-27/decisions.md): the stream holds
// the records the capture port delivered, none today, so it is written empty ("the stream, empty
// when nothing was observed"). With no correlated late record the assessment re-evaluates nothing
// and reads only each frozen result's exact bytes. The frozen ingestion input of a trial is rebuilt
// from the package as the trial freeze composed it (its own files, the execution-level files that
// existed at freeze, and the earlier trials' files as execution scope); the runner journal has grown
// since, which matters only once late records are captured.

import type { StepReport } from '../cleanup/cleanup-ports.ts';
import type { IngestionInput } from '../evidence-ingestion/ingestion-model.ts';
import { expectedArtifactsFor } from '../evidence-package/expected-artifacts.ts';
import type { PackageFile } from '../evidence-package/package-file-system.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import { serializeRecordFile } from '../record-contract/canonical-json.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import type { DeclaredTrial } from '../record-contract/records/group-a/execution_manifest.ts';
import type { TrialExecutionIdentity } from '../record-contract/records/group-c/shared-shapes.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { readRecordFile } from '../study-comparison/record-files.ts';
import { assessLateEvidence } from '../trial-oracle/late-evidence/assess-late-evidence.ts';
import type { FrozenTrialEvidence } from '../trial-oracle/late-evidence/late-evidence-input.ts';
import type { AdmittedExecution, ExecutionServices } from './execution-ports.ts';
import type { ExecutionPackage } from './execution-package.ts';
import { filesByPath } from './execution-package.ts';
import type { LateEvidenceMonitor } from './late-monitoring.ts';

/** Steps 1 and 2, as cleanup runs them. */
export interface LateEvidenceSteps {
  cutoff(): Promise<StepReport>;
  freezeAssessment(): Promise<StepReport>;
}

// Package areas written after every trial froze: never part of a trial's frozen input.
const WRITTEN_AFTER_FREEZE = ['late-evidence/', 'cleanup/', 'summary/', 'readiness/', 'provider/'];

/**
 * The late-evidence steps of one run or variant validation.
 *
 * @example
 * const steps = new LateEvidenceFreeze({ admitted, execution: { run_id }, pkg, monitor, services });
 * await steps.cutoff(); // writes late-evidence/late-evidence-stream.jsonl
 */
export class LateEvidenceFreeze implements LateEvidenceSteps {
  readonly #context: LateEvidenceContext;

  constructor(context: LateEvidenceContext) {
    this.#context = context;
  }

  /** Step 1: writes the stream monitoring observed; skipped when monitoring never ran. */
  async cutoff(): Promise<StepReport> {
    if (this.#context.monitor.monitoring().outcome === 'skipped') {
      return {
        status: 'skipped',
        reasons: [
          lateReason(
            'LATE_MONITORING_SKIPPED',
            'late monitoring did not run; expected late evidence to stay unverified',
          ),
        ],
      };
    }
    const unwritten = await this.#context.pkg.writeOnce(EXECUTION_PATHS.lateEvidenceStream, new Uint8Array());
    return unwritten === undefined ? { status: 'succeeded', reasons: [] } : { status: 'failed', reasons: [unwritten] };
  }

  /** Step 2: assesses and freezes the late evidence of every frozen trial. */
  async freezeAssessment(): Promise<StepReport> {
    const { pkg, admitted, monitor, services } = this.#context;
    const files = await pkg.snapshot();
    if (!files.ok) {
      return { status: 'failed', reasons: [files.error] };
    }
    const trials = frozenTrials(files.value, admitted, services);
    if (!trials.ok) {
      return { status: 'failed', reasons: trials.error };
    }
    const stream = files.value.find((file) => file.path === EXECUTION_PATHS.lateEvidenceStream);
    const assessment = assessLateEvidence(
      {
        execution: this.#context.execution,
        execution_manifest_sha256: admitted.manifest_sha256,
        monitoring: monitor.monitoring(),
        ...(stream === undefined ? {} : { stream }),
        trials: trials.value,
        assessed_at: formatUtcMillis(services.clock.now()),
      },
      services.validator,
    );
    if (!assessment.ok) {
      return { status: 'failed', reasons: assessment.error };
    }
    const unwritten = await pkg.writeOnce(
      EXECUTION_PATHS.lateEvidenceAssessment,
      serializeRecordFile(assessment.value),
    );
    return unwritten === undefined ? { status: 'succeeded', reasons: [] } : { status: 'failed', reasons: [unwritten] };
  }
}

/** What the late-evidence steps read and write. */
export interface LateEvidenceContext {
  readonly admitted: AdmittedExecution;
  readonly execution: TrialExecutionIdentity;
  readonly pkg: ExecutionPackage;
  readonly monitor: LateEvidenceMonitor;
  readonly services: ExecutionServices;
}

// Every declared trial that froze an oracle result, in declared order.
function frozenTrials(
  files: readonly PackageFile[],
  admitted: AdmittedExecution,
  services: ExecutionServices,
): Result<readonly FrozenTrialEvidence[], readonly StructuredReason[]> {
  const byPath = filesByPath(files);
  const trials = admitted.manifest.trials;
  const evidence: FrozenTrialEvidence[] = [];
  const reasons: StructuredReason[] = [];
  for (const [index, trial] of trials.entries()) {
    const path = PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: trial.trial_id }, 'oracleResult');
    const bytes = byPath.get(path);
    if (bytes === undefined) {
      continue;
    }
    const input = frozenInput(files, trial, trials.slice(0, index), services);
    if (!input.ok) {
      reasons.push(input.error);
      continue;
    }
    evidence.push({ frozen: input.value, result: { path, bytes } });
  }
  return reasons.length > 0 ? err(reasons) : ok(evidence);
}

function frozenInput(
  files: readonly PackageFile[],
  trial: DeclaredTrial,
  earlier: readonly DeclaredTrial[],
  services: ExecutionServices,
): Result<IngestionInput, StructuredReason> {
  const unit = { kind: 'trial', trial_id: trial.trial_id } as const;
  const manifestPath = PACKAGE_LAYOUT.unitFile(unit, 'trialManifest');
  const manifest = readRecordFile(filesByPath(files), manifestPath, 'trial_manifest', {
    validator: services.validator,
    digest: sha256Hex,
  });
  if (manifest.status !== 'read') {
    const why = manifest.status === 'absent' ? `${manifestPath} is absent` : manifest.reason.detail;
    return err(
      lateReason(
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
        (!file.path.startsWith('trials/') && !WRITTEN_AFTER_FREEZE.some((prefix) => file.path.startsWith(prefix))),
    ),
    expected: expectedArtifactsFor(manifest.frozen.record),
    execution_scope_artifacts: files.filter((file) => scopes.some((prefix) => file.path.startsWith(prefix))),
  });
}

function lateReason(code: string, detail: string): StructuredReason {
  return { code, subject: 'BR-RUA-043', detail };
}
