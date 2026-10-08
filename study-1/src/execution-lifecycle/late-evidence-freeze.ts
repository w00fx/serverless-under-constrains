// Cleanup steps 1 and 2 of any execution (design §10.4; BR-RUA-043, BR-RUA-048, BR-RUA-049;
// AC-RUA-030): step 1 completes the late-evidence cutoff by re-reading every frozen unit's sources
// with the late-record capture (evidence-collection `captureLateRecords`) and writing the stream it
// returns; step 2 freezes `late-evidence/late-evidence-assessment.json` from the stream, how
// monitoring ended and every frozen trial result or the frozen probe result
// (package-late-evidence.ts). Monitoring that was skipped or shortened leaves late evidence
// `unverified`. A capture that fails writes no stream and declares monitoring `failed`: what it
// could not read is never turned into an empty stream, which would claim that nothing was observed
// and read as `none`.

import type { StepReport } from '../cleanup/cleanup-ports.ts';
import { captureLateRecords } from '../evidence-collection/late-record-capture.ts';
import type { LateCapturePorts } from '../evidence-collection/late-record-capture.ts';
import { EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import { serializeRecordFile } from '../record-contract/canonical-json.ts';
import type { StructuredReason } from '../record-contract/primitives.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { LateMonitoring } from '../trial-oracle/late-evidence/late-evidence-input.ts';
import type { AdmittedExecution, ExecutionServices, ExecutionTargets } from './execution-ports.ts';
import type { ExecutionPackage } from './execution-package.ts';
import { filesByPath } from './execution-package.ts';
import { frozenInputReason } from './frozen-trial-input.ts';
import { lateCapturePlan } from './late-capture-plan.ts';
import type { LateEvidenceMonitor } from './late-monitoring.ts';
import { assessPackageLateEvidence } from './package-late-evidence.ts';

/** Steps 1 and 2, as cleanup runs them. */
export interface LateEvidenceSteps {
  cutoff(): Promise<StepReport>;
  freezeAssessment(): Promise<StepReport>;
}

/** What the late-evidence steps read and write. */
export interface LateEvidenceContext {
  readonly admitted: AdmittedExecution;
  readonly pkg: ExecutionPackage;
  readonly monitor: LateEvidenceMonitor;
  /** The capture's readers; its clock is the services' clock. */
  readonly capture: Omit<LateCapturePorts, 'clock'>;
  /** What the deployed stack names (each queued trial's DLQ); absent after a failed deploy. */
  readonly targets: ExecutionTargets | undefined;
  readonly services: ExecutionServices;
}

/**
 * The late-evidence steps of one execution.
 *
 * @example
 * const steps = new LateEvidenceFreeze({ admitted, pkg, monitor, capture: { store, dlq, durable }, targets, services });
 * await steps.cutoff(); // writes late-evidence/late-evidence-stream.jsonl
 */
export class LateEvidenceFreeze implements LateEvidenceSteps {
  readonly #context: LateEvidenceContext;
  #captureFailed = false;

  constructor(context: LateEvidenceContext) {
    this.#context = context;
  }

  /** Step 1: captures and writes the late stream; skipped when monitoring never ran. */
  async cutoff(): Promise<StepReport> {
    const { monitor, pkg, admitted, capture, targets, services } = this.#context;
    if (monitor.monitoring().outcome === 'skipped') {
      return {
        status: 'skipped',
        reasons: [
          frozenInputReason(
            'LATE_MONITORING_SKIPPED',
            'late monitoring did not run; expected late evidence to stay unverified',
          ),
        ],
      };
    }
    const files = await pkg.snapshot();
    const stream = files.ok
      ? await captureLateRecords(
          { ...capture, clock: services.clock },
          lateCapturePlan(filesByPath(files.value), admitted, targets),
        )
      : undefined;
    if (stream?.ok !== true) {
      this.#captureFailed = true;
      return { status: 'failed', reasons: captureFailure(files.ok ? [] : [files.error], stream) };
    }
    const unwritten = await pkg.writeOnce(EXECUTION_PATHS.lateEvidenceStream, stream.value.bytes);
    return unwritten === undefined ? { status: 'succeeded', reasons: [] } : { status: 'failed', reasons: [unwritten] };
  }

  /** Step 2: assesses and freezes the late evidence of every frozen trial or of the frozen probe. */
  async freezeAssessment(): Promise<StepReport> {
    const { pkg, admitted, services } = this.#context;
    const files = await pkg.snapshot();
    if (!files.ok) {
      return { status: 'failed', reasons: [files.error] };
    }
    const stream = files.value.find((file) => file.path === EXECUTION_PATHS.lateEvidenceStream);
    const assessment = assessPackageLateEvidence(
      {
        files: files.value,
        admitted,
        monitoring: this.#monitoring(),
        ...(stream === undefined ? {} : { stream }),
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

  // A failed capture observed nothing verifiable: monitoring failed, within the window it ran.
  #monitoring(): LateMonitoring {
    const monitoring = this.#context.monitor.monitoring();
    if (!this.#captureFailed || monitoring.outcome === 'skipped') {
      return monitoring;
    }
    return { ...monitoring, outcome: 'failed' };
  }
}

function captureFailure(
  snapshot: readonly StructuredReason[],
  stream: Awaited<ReturnType<typeof captureLateRecords>> | undefined,
): readonly StructuredReason[] {
  const capture = stream === undefined || stream.ok ? [] : stream.error;
  return [
    ...snapshot,
    ...capture,
    frozenInputReason(
      'LATE_CAPTURE_FAILED',
      'the late-record capture did not complete; expected late evidence to be unverified, never none',
    ),
  ];
}
