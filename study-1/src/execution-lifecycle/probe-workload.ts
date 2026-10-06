// P4 and P5 of a transport probe (design §10.2; BR-RUA-027, BR-RUA-044, BR-RUA-045): the probe's
// single workload is planned from the frozen manifest and the deployed published versions, handed to
// the probe runner behind the publication gate, and frozen with the runner's coordination
// checkpoint. The runner journals:
//   TRIALS (P4)        failed when the probe could not be planned or never started, or when an
//                      interruption ended it; otherwise succeeded (its Invoke may have run);
//   PROBE_FREEZE (P5)  started by the checkpoint, then succeeded when the probe froze and the
//                      package holds both the transport probe result and the checkpoint, failed
//                      otherwise; skipped when the freeze never reached P5.

import type { PackageFileSystem } from '../evidence-package/package-file-system.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import { planProbeWorkload } from '../trial-execution/probe-workload-plan.ts';
import type { ProbeExecution, ProbeExecutionReport } from '../trial-execution/trial-execution-ports.ts';
import { CoordinationPrefixCheckpointer } from './coordination-checkpointer.ts';
import type { ProbeRunner } from './execution-ports.ts';
import type { ExecutionWorkload, WorkloadContext, WorkloadOutcome } from './execution-workload.ts';
import { awaitUnitStart, interruptionReason } from './trial-workload.ts';

const FROZEN_PROBE_FILES: readonly string[] = [
  PACKAGE_LAYOUT.unitFile({ kind: 'probe' }, 'transportProbeResult'),
  EXECUTION_PATHS.coordinationPrefixCheckpoint,
];

/**
 * The single workload of one transport probe.
 *
 * @example
 * const outcome = await new ProbeWorkload(identity, probeRunner, files).run(context);
 * outcome.probe?.kind; // 'frozen'
 */
export class ProbeWorkload implements ExecutionWorkload {
  readonly #identity: ProbeExecution;
  readonly #probe: ProbeRunner;
  readonly #files: PackageFileSystem;

  constructor(identity: ProbeExecution, probe: ProbeRunner, files: PackageFileSystem) {
    this.#identity = identity;
    this.#probe = probe;
    this.#files = files;
  }

  async run(context: WorkloadContext): Promise<WorkloadOutcome> {
    const { journal, admitted, targets } = context;
    await journal.phase('TRIALS', 'started');
    const plan = planProbeWorkload(admitted.manifest, admitted.manifest_sha256, {
      provider_version: targets.provider_version,
      probe_caller_version: targets.probe_caller?.version ?? '',
    });
    if (!plan.ok) {
      await journal.phase('TRIALS', 'failed', [plan.error]);
      await journal.phase('PROBE_FREEZE', 'skipped', [plan.error]);
      return { completed: false, trials: [], reasons: [plan.error] };
    }
    const checkpoint = new CoordinationPrefixCheckpointer({
      files: this.#files,
      package_directory: admitted.package_directory,
      transport_probe_id: this.#identity.transport_probe_id,
      execution_manifest_sha256: admitted.manifest_sha256,
      journal,
      clock: context.services.clock,
    });
    const report = (await awaitUnitStart(context.gate, context.services.sleeper))
      ? await this.#probe.execute(plan.value, context.gate, checkpoint)
      : undefined;
    if (report?.kind === 'frozen' && report.interruption !== undefined) {
      context.unitRecordedInterruption();
    }
    const interruption = await context.noteInterruption();
    const stop = interruption === undefined ? [] : [interruptionReason(interruption)];
    await journal.phase('TRIALS', workloadFailed(report, stop) ? 'failed' : 'succeeded', [
      ...notStarted(report),
      ...stop,
    ]);
    await this.#closeFreeze(context, report, checkpoint.invoked());
    return {
      completed: interruption === undefined,
      trials: [],
      ...(report === undefined ? {} : { probe: report }),
      reasons: [],
    };
  }

  // P5 as the package shows it: the freeze reached the checkpoint, and both files P5 writes exist.
  async #closeFreeze(
    context: WorkloadContext,
    report: ProbeExecutionReport | undefined,
    invoked: boolean,
  ): Promise<void> {
    if (!invoked) {
      await context.journal.phase('PROBE_FREEZE', 'skipped', notStarted(report));
      return;
    }
    const frozen = await this.#frozenFiles(context);
    const failures = [...(report?.kind === 'freeze_failed' ? report.reasons : []), ...(frozen.ok ? [] : frozen.error)];
    await context.journal.phase('PROBE_FREEZE', failures.length === 0 ? 'succeeded' : 'failed', failures);
  }

  async #frozenFiles(context: WorkloadContext): Promise<Result<void, readonly StructuredReason[]>> {
    const missing: StructuredReason[] = [];
    for (const path of FROZEN_PROBE_FILES) {
      const read = await this.#files.read(`${context.admitted.package_directory}/${path}`);
      if (!read.ok) {
        missing.push({
          code: 'PROBE_FREEZE_INCOMPLETE',
          subject: 'BR-RUA-044',
          artifact_path: path,
          detail: `${path} is not in the package (${read.error.code}); expected it frozen at P5`,
        });
      }
    }
    return missing.length === 0 ? ok(undefined) : err(missing);
  }
}

// A probe that never started (or that the gate never let start) failed P4.
function workloadFailed(report: ProbeExecutionReport | undefined, stop: readonly StructuredReason[]): boolean {
  return report === undefined || report.kind === 'not_started' || stop.length > 0;
}

function notStarted(report: ProbeExecutionReport | undefined): readonly StructuredReason[] {
  if (report === undefined) {
    return [
      {
        code: 'PROBE_NOT_HANDED_OVER',
        subject: 'BR-RUA-046',
        detail: 'the publication gate refused the probe start; expected the probe to start within the safety limits',
      },
    ];
  }
  return report.kind === 'not_started' ? report.reasons : [];
}
