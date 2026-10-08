// The workload phase of an execution (design §10.2 P4, and P5 for the probe): the runner owns
// P1-P3 and P6-P9 for every kind, and hands P4 to the workload of its kind (trial-workload.ts for a
// run or a variant validation, probe-workload.ts for a transport probe). Type-only: no runtime code
// (A-10).

import type { Sha256Hex, StructuredReason } from '../record-contract/primitives.ts';
import type {
  ProbeExecutionReport,
  TrialExecutionReport,
  TrialInterruption,
} from '../trial-execution/trial-execution-ports.ts';
import type { ExecutionGate } from './execution-gate.ts';
import type { ExecutionPhaseJournal } from './execution-journal.ts';
import type { AdmittedExecution, ExecutionServices, ExecutionTargets } from './execution-ports.ts';

/** What the runner hands its workload once the execution is ready (after P3). */
export interface WorkloadContext {
  readonly admitted: AdmittedExecution;
  readonly resource_manifest_sha256: Sha256Hex;
  readonly targets: ExecutionTargets;
  readonly gate: ExecutionGate;
  readonly journal: ExecutionPhaseJournal;
  readonly services: ExecutionServices;
  /** Journals, once, an interruption no unit recorded; the interruption, when there is one. */
  noteInterruption(): Promise<TrialInterruption | undefined>;
  /** A unit journaled the interruption itself, so the runner must not journal it again. */
  unitRecordedInterruption(): void;
}

/** How the workload ended. */
export interface WorkloadOutcome {
  /** True when late monitoring follows: nothing interrupted the workload and it could be planned. */
  readonly completed: boolean;
  readonly trials: readonly TrialExecutionReport[];
  readonly probe?: ProbeExecutionReport;
  /** Why the workload could not be planned, for the execution outcome. */
  readonly reasons: readonly StructuredReason[];
}

/** P4 (and P5 for the probe) of one execution kind. */
export interface ExecutionWorkload {
  run(context: WorkloadContext): Promise<WorkloadOutcome>;
}
