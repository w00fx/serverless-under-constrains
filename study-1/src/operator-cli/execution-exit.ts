// How an execution or a recovery ended, as the operator CLI reports it (design §11 exit codes;
// §10.2 P1-P9; BR-RUA-038, BR-RUA-045, BR-RUA-048, BR-RUA-051). When several apply, the most
// severe wins, in this order:
//   10 internal_failure               the package was not finalized (no package-index.json last)
//    7 lease_problem                  the lease is `unverified`, or it was never held: acquisition
//                                     was refused (a conflicting holder) or its write was ambiguous
//                                     (finalized without running anything)
//    6 operational_closure_not_clean  cleanup not `succeeded`, the audit not `clean`, or the lease
//                                     left `recovery_required`
//    4 execution_incomplete           an interruption, or a declared unit that did not freeze
//    0 completed                      every declared unit froze and the closure is clean
// A frozen unit whose settlement is indeterminate still completed its execution: the verdict is
// the verifier's question, never the executor's. Every outcome but `completed` states why.

import type { AdmittedExecution, ExecutionOutcome } from '../execution-lifecycle/execution-ports.ts';
import { EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import type { StructuredReason } from '../record-contract/primitives.ts';
import type { CliOutcome, LeaseStatus } from '../record-contract/records/group-c/vocabulary.ts';
import type { CliOutcomeReport } from './cli-types.ts';

/** The operational closure of an execution or of a recovery. */
export interface OperationalClosureView {
  readonly cleanup_status?: string;
  readonly leak_audit_status?: string;
  readonly lease_status?: LeaseStatus;
}

/** An outcome and, unless it is `completed`, the reason for it. */
export interface Verdict {
  readonly outcome: CliOutcome;
  readonly reason?: StructuredReason;
}

const COMPLETED: Verdict = { outcome: 'completed' };

/**
 * The CLI report of one finished `probe|validation|run execute`.
 *
 * @example
 * executionReport(admitted, await runner.runCanonical()).outcome; // 'completed' after a clean run
 */
export function executionReport(admitted: AdmittedExecution, outcome: ExecutionOutcome): CliOutcomeReport {
  const verdict = executionVerdict(admitted, outcome);
  return {
    outcome: verdict.outcome,
    execution: admitted.identity,
    written_paths: outcome.package_finalized ? [`${admitted.package_directory}/${EXECUTION_PATHS.packageIndex}`] : [],
    reasons: verdict.reason === undefined ? outcome.reasons : [...outcome.reasons, verdict.reason],
  };
}

/**
 * The outcome of an operational closure alone (`recover`): lease first, then cleanup and audit.
 *
 * @example
 * closureVerdict({ cleanup_status: 'succeeded', leak_audit_status: 'clean', lease_status: 'released' }).outcome; // 'completed'
 */
export function closureVerdict(closure: OperationalClosureView): Verdict {
  if (closure.lease_status === 'unverified') {
    return verdict('lease_problem', 'LEASE_UNVERIFIED', 'BR-RUA-045', 'the lease is unverified; expected released');
  }
  const cleanUp = closure.cleanup_status === undefined || closure.cleanup_status === 'succeeded';
  const audited = closure.cleanup_status === undefined || closure.leak_audit_status === 'clean';
  if (!cleanUp || !audited || closure.lease_status === 'recovery_required') {
    return verdict(
      'operational_closure_not_clean',
      'OPERATIONAL_CLOSURE_NOT_CLEAN',
      'BR-RUA-048',
      `cleanup ${String(closure.cleanup_status)}, leak audit ${String(closure.leak_audit_status)}, lease ${String(closure.lease_status)}; expected cleanup succeeded, audit clean and lease released`,
    );
  }
  return COMPLETED;
}

function executionVerdict(admitted: AdmittedExecution, outcome: ExecutionOutcome): Verdict {
  if (!outcome.package_finalized) {
    return verdict(
      'internal_failure',
      'PACKAGE_NOT_FINALIZED',
      'BR-RUA-044',
      `${admitted.package_directory} was not finalized; expected package-index.json written last`,
    );
  }
  // Once the lease is held, P7 freezes a cleanup result, or P8 marks the lease for recovery when P2
  // froze nothing cleanup could act on; neither happens when no lease was ever held.
  const held = outcome.cleanup_status !== undefined || outcome.lease_status === 'recovery_required';
  if (!held && outcome.interruption === undefined) {
    return verdict(
      'lease_problem',
      'LEASE_NOT_ACQUIRED',
      'BR-RUA-045',
      `the coordination lease was not held (lease ${String(outcome.lease_status)}; the runner journal's LEASE_ACQUISITION event names why); expected it acquired before the first deployment`,
    );
  }
  const closure = closureVerdict(outcome);
  return closure.outcome === 'completed' ? workloadVerdict(admitted, outcome) : closure;
}

// Every declared unit froze, none of them interrupted, and nothing interrupted the execution.
function workloadVerdict(admitted: AdmittedExecution, outcome: ExecutionOutcome): Verdict {
  const units = admitted.identity.execution_kind === 'TRANSPORT_PROBE' ? [outcome.probe] : outcome.trials;
  const declared = Math.max(admitted.manifest.trials.length, 1);
  const frozen = units.filter((unit) => unit?.kind === 'frozen' && unit.interruption === undefined).length;
  if (outcome.interruption === undefined && frozen === declared) {
    return COMPLETED;
  }
  const interruption =
    outcome.interruption === undefined ? 'none' : `${outcome.interruption.cause} (${outcome.interruption.detail})`;
  return verdict(
    'execution_incomplete',
    'EXECUTION_INCOMPLETE',
    'BR-RUA-019',
    `${String(frozen)} of ${String(declared)} declared units froze uninterrupted, interruption ${interruption}; expected every declared unit frozen without interruption`,
  );
}

function verdict(outcome: CliOutcome, code: string, subject: string, detail: string): Verdict {
  return { outcome, reason: { code, subject, detail } };
}
