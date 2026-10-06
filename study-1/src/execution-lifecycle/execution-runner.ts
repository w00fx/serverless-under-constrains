// The execution runner (design §10.2 P1-P9, §5.3 `ExecutionRunner`; BR-RUA-019, BR-RUA-028,
// BR-RUA-038, BR-RUA-043 to BR-RUA-049; AC-RUA-008, AC-RUA-049):
//   P1 lease.acquire, the execution's first mutation; a refusal finalizes without provisioning
//   P2 deploy, leaving the resource manifest; a failed deploy goes to emergency cleanup
//   P3 the A-09 configuration item, every mapping enabled and the controller canary acknowledged
//   P4 every declared trial in declared order, each behind the publication gate
//   P6 late monitoring of at least 120 s with consumers enabled
//   P7 cleanup steps 1-12, normal or emergency
//   P8 lease finalization: release after a clean closure, otherwise recovery
//   P9 safety assessment, summary, journals made read-only, package-index.json last
// The heartbeat runs beside P2-P8. Lease loss, SIGINT and the active-time deadline latch the gate:
// no trial starts after it, the active trial freezes indeterminate, monitoring is skipped and
// cleanup runs in emergency mode, past the total target if it must (a duration breach). The probe's
// workload phases (P4 Invoke, P5) are not bound here, so a probe is refused before any mutation
// (evidence/WP-27/decisions.md).

import { CleanupOrchestrator } from '../cleanup/cleanup-orchestrator.ts';
import type { CleanupRunOutcome } from '../cleanup/cleanup-orchestrator.ts';
import { createJsonlJournalPort } from '../event-journal/jsonl-journal-port.ts';
import { JournalWriter } from '../event-journal/journal-writer.ts';
import { EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import type { Sha256Hex, StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import { serializeRecordFile } from '../record-contract/canonical-json.ts';
import type { CleanupMode } from '../record-contract/records/group-b/vocabulary.ts';
import type { TrialExecutionIdentity } from '../record-contract/records/group-c/shared-shapes.ts';
import type { LeaseStatus } from '../record-contract/records/group-c/vocabulary.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { writeExecutionConfiguration } from '../trial-execution/execution-configuration.ts';
import { RUNNER_DEFINITIVE_RETRIES } from '../trial-execution/runner-trial-journal.ts';
import type {
  TrialExecution,
  TrialExecutionReport,
  TrialFrozen,
  TrialInterruption,
} from '../trial-execution/trial-execution-ports.ts';
import { ExecutionCleanupEvidence } from './cleanup-evidence.ts';
import { planCleanup } from './cleanup-plan.ts';
import { writeExecutionEvidence } from './execution-evidence.ts';
import { finalizePackage } from './execution-finalization.ts';
import type { SummaryWriter } from './execution-finalization.ts';
import { ExecutionGate } from './execution-gate.ts';
import type { AbortAnswer } from './execution-gate.ts';
import { ExecutionPhaseJournal } from './execution-journal.ts';
import { ExecutionPackage } from './execution-package.ts';
import type {
  AdmittedTrialExecution,
  CleanupBindings,
  EvidenceRoot,
  ExecutionEvidenceReaders,
  ExecutionLease,
  ExecutionOutcome,
  ExecutionProvisioner,
  ExecutionSafety,
  ExecutionSafetyFactory,
  ExecutionServices,
  ExecutionTargets,
  ProvisioningOutcome,
  TrialRunner,
} from './execution-ports.ts';
import { LateEvidenceFreeze } from './late-evidence-freeze.ts';
import { LateEvidenceMonitor } from './late-monitoring.ts';
import { confirmReadiness } from './readiness.ts';
import type { ReadinessPorts } from './readiness.ts';
import { buildSafetyAssessment } from './safety-assessment.ts';
import { planDeclaredTrials } from './trial-plans.ts';

/** How often the runner re-reads an uncertain lease before handing over the next trial. */
export const LEASE_RECOVERY_POLL_MS = 5_000;

/** Everything the runner acts through. */
export interface ExecutionRunnerDeps {
  readonly lease: ExecutionLease;
  readonly provisioner: ExecutionProvisioner;
  readonly readiness: Pick<ReadinessPorts, 'consumers'>;
  readonly trials: TrialRunner;
  readonly safety: ExecutionSafetyFactory;
  readonly cleanup: CleanupBindings;
  readonly readers: ExecutionEvidenceReaders;
  readonly evidence: EvidenceRoot;
  readonly summary: SummaryWriter;
  readonly services: ExecutionServices;
}

/** The closure P7 and P8 leave for P9. */
interface Closure {
  readonly cleanup?: CleanupRunOutcome;
  readonly lease_status?: LeaseStatus;
}

/**
 * Runs one admitted run or variant validation through P1-P9.
 *
 * @example
 * const runner = new ExecutionRunner(admitted, deps); // admitted = asTrialExecution(read)
 * process.once('SIGINT', () => runner.abort('SIGINT'));
 * const outcome = await runner.run();
 */
export class ExecutionRunner {
  readonly #admitted: AdmittedTrialExecution;
  readonly #deps: ExecutionRunnerDeps;
  readonly #gate: ExecutionGate;
  readonly #journal: ExecutionPhaseJournal;
  readonly #pkg: ExecutionPackage;
  readonly #monitor: LateEvidenceMonitor;
  readonly #reports: TrialExecutionReport[] = [];
  readonly #reasons: StructuredReason[] = [];
  #interruptionJournaled = false;

  constructor(admitted: AdmittedTrialExecution, deps: ExecutionRunnerDeps) {
    this.#admitted = admitted;
    this.#deps = deps;
    this.#gate = new ExecutionGate(deps.lease);
    this.#journal = new ExecutionPhaseJournal(admitted, deps.evidence.journals, deps.services);
    this.#pkg = new ExecutionPackage(deps.evidence.files, admitted.identity, admitted.package_directory);
    this.#monitor = new LateEvidenceMonitor(deps.services);
  }

  /** SIGINT: the first one interrupts with `OPERATOR_ABORT`; later ones are only reported (design §11). */
  abort(detail: string): AbortAnswer {
    return this.#gate.abort(detail);
  }

  /**
   * Runs the execution to its finalized package; never throws on a port failure.
   *
   * @example
   * (await runner.run()).package_finalized; // true once package-index.json was written last
   */
  async run(): Promise<ExecutionOutcome> {
    const held = await this.#acquireLease();
    if (held === undefined) {
      return this.#finalize(undefined, {});
    }
    const { safety } = held;
    const provisioned = await this.#provision();
    const { targets } = provisioned;
    const mode =
      targets === undefined ? 'EMERGENCY' : await this.#execute(provisioned.resource_manifest_sha256, targets, safety);
    safety.markActiveEnded();
    const cleanup = await this.#cleanUp(mode, provisioned, held);
    const leaseStatus = await this.#finalizeLease(cleanup);
    return this.#finalize(safety, { ...(cleanup === undefined ? {} : { cleanup }), lease_status: leaseStatus });
  }

  // P1. An abort that came before the first mutation stops the execution without one.
  async #acquireLease(): Promise<HeldExecution | undefined> {
    await this.#journal.phase('LEASE_ACQUISITION', 'started');
    const aborted = await this.#noteInterruption();
    if (aborted !== undefined) {
      await this.#journal.phase('LEASE_ACQUISITION', 'skipped', [interruptionReason(aborted)]);
      return undefined;
    }
    const { services } = this.#deps;
    const startedNs = services.monotonic.nowNs();
    const startedAt = formatUtcMillis(services.clock.now());
    const acquisition = await this.#deps.lease.acquire();
    if (!acquisition.acquired) {
      await this.#journal.phase('LEASE_ACQUISITION', 'failed', [acquisition.reason]);
      return undefined;
    }
    await this.#journal.phase('LEASE_ACQUISITION', 'succeeded');
    const safety = this.#deps.safety(startedNs, this.#admitted);
    this.#gate.arm(safety);
    this.#deps.lease.startHeartbeats((loss) => {
      this.#gate.interrupt({ cause: loss.cause, detail: `${loss.health}: ${loss.reason.detail}` });
    });
    return { safety, started_at: startedAt };
  }

  // P2.
  async #provision(): Promise<ProvisioningOutcome> {
    await this.#journal.phase('PROVISIONING', 'started');
    const outcome = await this.#deps.provisioner.provision(this.#admitted);
    const failed = outcome.targets === undefined;
    await this.#journal.phase('PROVISIONING', failed ? 'failed' : 'succeeded', outcome.reasons);
    return outcome;
  }

  // P3, P4 and P6; the cleanup mode they leave.
  async #execute(
    resourceManifestSha256: Sha256Hex,
    targets: ExecutionTargets,
    safety: ExecutionSafety,
  ): Promise<CleanupMode> {
    if (!(await this.#ready(targets)) || !(await this.#runTrials(resourceManifestSha256, targets))) {
      await this.#journal.phase('LATE_MONITORING', 'skipped', [this.#stopReason()]);
      return 'EMERGENCY';
    }
    safety.markActiveEnded();
    await this.#journal.phase('LATE_MONITORING', 'started');
    const monitoring = await this.#monitor.observe(this.#gate);
    // Journaled before the outcome is judged: a shortened window means an interruption no trial
    // recorded, and without its `trial_interrupted` the summary would read the run as COMPLETED.
    const interruption = await this.#noteInterruption();
    if (monitoring.outcome !== 'complete' || interruption !== undefined) {
      await this.#journal.phase('LATE_MONITORING', 'failed', [this.#stopReason()]);
      return 'EMERGENCY';
    }
    await this.#journal.phase('LATE_MONITORING', 'succeeded');
    return 'NORMAL';
  }

  // P3; false when the execution must not run trials.
  async #ready(targets: ExecutionTargets): Promise<boolean> {
    if ((await this.#noteInterruption()) !== undefined) {
      return false;
    }
    const started = await this.#journal.phase('READINESS', 'started');
    const { services, readers } = this.#deps;
    const configured = await writeExecutionConfiguration(
      readers.store,
      { execution: this.#admitted.identity, execution_manifest_sha256: this.#admitted.manifest_sha256 },
      services.clock,
    );
    const reasons = configured.ok
      ? await confirmReadiness(
          { consumers: this.#deps.readiness.consumers, store: readers.store, services },
          this.#admitted,
          targets.event_source_mapping_ids,
          started ?? services.ids.next(),
        )
      : [configured.error];
    const interruption = await this.#noteInterruption();
    const failures = [...reasons, ...(interruption === undefined ? [] : [interruptionReason(interruption)])];
    await this.#journal.phase('READINESS', failures.length > 0 ? 'failed' : 'succeeded', failures);
    return failures.length === 0;
  }

  // P4; false when the trials were interrupted or could not be planned.
  async #runTrials(resourceManifestSha256: Sha256Hex, targets: ExecutionTargets): Promise<boolean> {
    await this.#journal.phase('TRIALS', 'started');
    const plans = planDeclaredTrials({
      admitted: this.#admitted,
      resource_manifest_sha256: resourceManifestSha256,
      targets,
    });
    if (!plans.ok) {
      this.#reasons.push(plans.error);
      await this.#journal.phase('TRIALS', 'failed', [plans.error]);
      return false;
    }
    for (const plan of plans.value) {
      if (!(await this.#awaitTrialStart())) {
        break;
      }
      const report = await this.#deps.trials.execute(plan, this.#gate);
      this.#reports.push(report);
      this.#interruptionJournaled ||= report.kind === 'frozen' && report.interruption !== undefined;
    }
    const interruption = await this.#noteInterruption();
    if (interruption !== undefined) {
      await this.#journal.phase('TRIALS', 'failed', [interruptionReason(interruption)]);
      return false;
    }
    const unfrozen = this.#reports.filter(
      (report): report is Exclude<TrialExecutionReport, TrialFrozen> => report.kind !== 'frozen',
    );
    await this.#journal.phase(
      'TRIALS',
      unfrozen.length === 0 ? 'succeeded' : 'failed',
      unfrozen.flatMap((report) => report.reasons),
    );
    return true;
  }

  // BR-RUA-045: lease uncertainty blocks new publication without ending the execution, and a
  // recovery before staleness may resume scheduling. Handing a trial over while the lease is
  // uncertain would consume it (its setup runs, then T5 refuses to publish), so the runner waits
  // until the heartbeat confirms the lease again or loses it at the 300 s stale boundary (the loss
  // latches the gate); the active-time deadline bounds the wait as well. False when no trial may start.
  async #awaitTrialStart(): Promise<boolean> {
    while (this.#gate.mayStartTrial() && !this.#gate.publicationAllowed()) {
      await this.#deps.services.sleeper.sleep(LEASE_RECOVERY_POLL_MS);
    }
    return this.#gate.mayStartTrial();
  }

  // P7.
  async #cleanUp(
    mode: CleanupMode,
    provisioned: ProvisioningOutcome,
    held: HeldExecution,
  ): Promise<CleanupRunOutcome | undefined> {
    await this.#journal.phase('CLEANUP', 'started');
    const { readers, services, evidence } = this.#deps;
    this.#reasons.push(...(await writeExecutionEvidence(readers.store, this.#admitted, this.#pkg)));
    const plan = planCleanup({
      admitted: this.#admitted,
      resource_manifest: provisioned.resource_manifest,
      targets: provisioned.targets,
      history: { entries: [], findings: [] },
      started_at: held.started_at,
    });
    if (!plan.ok) {
      await this.#journal.phase('CLEANUP', 'failed', [plan.error]);
      return undefined;
    }
    const late = new LateEvidenceFreeze({
      admitted: this.#admitted,
      execution: lateEvidenceIdentity(this.#admitted.identity),
      pkg: this.#pkg,
      monitor: this.#monitor,
      services,
    });
    const orchestrator = new CleanupOrchestrator({
      ...this.#deps.cleanup,
      evidence: new ExecutionCleanupEvidence({
        pkg: this.#pkg,
        sink: this.#pkg,
        paths: CLEANUP_PACKAGE_PATHS,
        late,
        readers,
        snapshot: plan.value.snapshot,
        services,
      }),
      journal: new JournalWriter({
        port: createJsonlJournalPort(
          `${this.#admitted.package_directory}/${EXECUTION_PATHS.cleanupJournal}`,
          evidence.journals,
        ),
        source: 'cleanup',
        instanceId: services.ids.next(),
        scope: {
          execution: this.#admitted.identity,
          execution_manifest_sha256: this.#admitted.manifest_sha256,
          partition: { kind: 'execution' },
        },
        clock: services.clock,
        ids: services.ids,
        maxDefinitiveRetries: RUNNER_DEFINITIVE_RETRIES,
      }),
      safety: held.safety,
      clock: services.clock,
    });
    const outcome =
      mode === 'NORMAL'
        ? await orchestrator.runNormal(plan.value.input)
        : await orchestrator.runEmergency(plan.value.input);
    const closed = outcome.cleanup_result.cleanup_status === 'succeeded' && outcome.freeze.status === 'succeeded';
    await this.#journal.phase('CLEANUP', closed ? 'succeeded' : 'failed', outcome.freeze.reasons);
    return outcome;
  }

  // P8: release after a clean closure, otherwise mark recovery required.
  async #finalizeLease(cleanup: CleanupRunOutcome | undefined): Promise<LeaseStatus> {
    this.#deps.lease.stopHeartbeats();
    await this.#journal.phase('LEASE_FINALIZATION', 'started');
    // Clean only when the closure is also frozen in the package: a release must be provable.
    const clean =
      cleanup?.cleanup_result.cleanup_status === 'succeeded' &&
      cleanup.leak_audit_result.leak_audit_status === 'clean' &&
      cleanup.freeze.status === 'succeeded';
    const status = await this.#deps.lease.finalize(clean ? 'clean' : 'unclean');
    await this.#journal.phase('LEASE_FINALIZATION', status === 'unverified' ? 'failed' : 'succeeded');
    return status;
  }

  // P9.
  async #finalize(safety: ExecutionSafety | undefined, closure: Closure): Promise<ExecutionOutcome> {
    const { services } = this.#deps;
    await this.#journal.phase('SUMMARY', 'started');
    const now = formatUtcMillis(services.clock.now());
    const assessment = safety === undefined ? undefined : buildSafetyAssessment(this.#admitted, safety.checks(), now);
    const unwritten =
      assessment === undefined
        ? undefined
        : await this.#pkg.writeOnce(EXECUTION_PATHS.safetyAssessment, serializeRecordFile(assessment));
    const summary = [
      ...(unwritten === undefined ? [] : [unwritten]),
      ...(await this.#deps.summary.write(this.#pkg, this.#admitted, now)),
    ];
    await this.#journal.phase('SUMMARY', summary.length === 0 ? 'succeeded' : 'failed', summary);
    const index = await finalizePackage(
      this.#pkg,
      this.#deps.evidence.journals,
      this.#admitted,
      formatUtcMillis(services.clock.now()),
    );
    const reasons = [...this.#reasons, ...summary, ...(index.ok ? [] : index.error)];
    for (const reason of reasons) {
      services.log({ level: 'warn', event: 'execution_reason', detail: `${reason.code}: ${reason.detail}` });
    }
    const interruption = this.#gate.latched();
    return {
      package_finalized: index.ok,
      ...(interruption === undefined ? {} : { interruption }),
      trials: [...this.#reports],
      ...(closure.cleanup === undefined
        ? {}
        : {
            cleanup_status: closure.cleanup.cleanup_result.cleanup_status,
            leak_audit_status: closure.cleanup.leak_audit_result.leak_audit_status,
          }),
      ...(closure.lease_status === undefined ? {} : { lease_status: closure.lease_status }),
      reasons,
    };
  }

  // Records, once, an interruption no trial recorded; the interruption, when there is one.
  async #noteInterruption(): Promise<TrialInterruption | undefined> {
    const interruption = this.#gate.interruption();
    if (interruption !== undefined && !this.#interruptionJournaled) {
      this.#interruptionJournaled = true;
      this.#deps.services.log({
        level: 'warn',
        event: 'execution_interrupted',
        detail: `${interruption.cause}: ${interruption.detail}`,
      });
      await this.#journal.interrupted(interruption);
    }
    return interruption;
  }

  // Why monitoring did not run to completion: the interruption, or the phase that failed before it.
  #stopReason(): StructuredReason {
    const interruption = this.#gate.latched();
    return interruption === undefined
      ? {
          code: 'LATE_MONITORING_NOT_REACHED',
          subject: 'BR-RUA-043',
          detail: 'an earlier phase failed; expected late evidence to stay unverified',
        }
      : interruptionReason(interruption);
  }
}

/** The lease is held: the deadline clock runs from the first mutation. */
interface HeldExecution {
  readonly safety: ExecutionSafety;
  readonly started_at: UtcMillis;
}

function interruptionReason(interruption: TrialInterruption): StructuredReason {
  return {
    code: 'EXECUTION_INTERRUPTED',
    subject: 'BR-RUA-046',
    detail: `${interruption.cause}: ${interruption.detail}; expected no interruption before closure`,
  };
}

/** Where the runner's cleanup evidence lands inside the package. */
const CLEANUP_PACKAGE_PATHS = {
  pre_cleanup_snapshot: EXECUTION_PATHS.preCleanupSnapshot,
  cleanup_result: EXECUTION_PATHS.cleanupResult,
  leak_audit_result: EXECUTION_PATHS.leakAuditResult,
} as const;

function lateEvidenceIdentity(execution: TrialExecution): TrialExecutionIdentity {
  return execution.execution_kind === 'RUN'
    ? { run_id: execution.run_id }
    : { variant_validation_id: execution.variant_validation_id };
}
