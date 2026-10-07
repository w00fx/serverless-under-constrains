// The execution runner (design §10.2 P1-P9, §5.3 `ExecutionRunner`; BR-RUA-019, BR-RUA-027,
// BR-RUA-028, BR-RUA-038, BR-RUA-043 to BR-RUA-049; AC-RUA-002, AC-RUA-008, AC-RUA-021,
// AC-RUA-027, AC-RUA-049). One admitted execution of any kind runs through the same phases:
//   P1 lease.acquire, the execution's first mutation; a refusal finalizes without provisioning
//   P2 deploy, leaving the resource manifest; a failed deploy goes to emergency cleanup
//   P3 the A-09 configuration item, every mapping enabled and the controller canary acknowledged
//   P4 the workload of the kind: every declared trial in declared order (trial-workload.ts), or the
//      probe's single workload (probe-workload.ts), each behind the publication gate
//   P5 for the probe: the transport probe result and the coordination prefix checkpoint
//   P6 late monitoring of at least 120 s with consumers enabled
//   P7 cleanup steps 1-12, normal or emergency
//   P8 lease finalization: release after a clean closure, otherwise recovery
//   P9 safety assessment, summary, journals made read-only, package-index.json last
// The heartbeat runs beside P2-P8. Lease loss, SIGINT and the active-time deadline latch the gate:
// no unit starts after it, the active unit freezes indeterminate, monitoring is skipped and
// cleanup runs in emergency mode, past the total target if it must (a duration breach).

import { CleanupOrchestrator } from '../cleanup/cleanup-orchestrator.ts';
import type { CleanupRunOutcome } from '../cleanup/cleanup-orchestrator.ts';
import type { LeaseClosure } from '../coordination-lease/lease-finalization.ts';
import { LEASE_REASON_CODES } from '../coordination-lease/lease-item.ts';
import { createJsonlJournalPort } from '../event-journal/jsonl-journal-port.ts';
import { JournalWriter } from '../event-journal/journal-writer.ts';
import { EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import type { ExecutionKind, Sha256Hex, StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import { serializeRecordFile } from '../record-contract/canonical-json.ts';
import type { CleanupMode } from '../record-contract/records/group-b/vocabulary.ts';
import type { LeaseStatus } from '../record-contract/records/group-c/vocabulary.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { writeExecutionConfiguration } from '../trial-execution/execution-configuration.ts';
import { RUNNER_DEFINITIVE_RETRIES } from '../trial-execution/runner-trial-journal.ts';
import type { TrialInterruption } from '../trial-execution/trial-execution-ports.ts';
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
  AdmittedExecution,
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
  ProbeRunner,
  ProvisioningOutcome,
  TrialRunner,
} from './execution-ports.ts';
import type { ExecutionWorkload, WorkloadContext, WorkloadOutcome } from './execution-workload.ts';
import { LateEvidenceFreeze } from './late-evidence-freeze.ts';
import { LateEvidenceMonitor } from './late-monitoring.ts';
import { ProbeWorkload } from './probe-workload.ts';
import { confirmReadiness } from './readiness.ts';
import type { ReadinessPorts } from './readiness.ts';
import { buildSafetyAssessment } from './safety-assessment.ts';
import { interruptionReason, TrialWorkload } from './trial-workload.ts';

export { LEASE_RECOVERY_POLL_MS } from './trial-workload.ts';

/** Everything the runner acts through. */
export interface ExecutionRunnerDeps {
  readonly lease: ExecutionLease;
  readonly provisioner: ExecutionProvisioner;
  readonly readiness: Pick<ReadinessPorts, 'consumers'>;
  readonly trials: TrialRunner;
  readonly probe: ProbeRunner;
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

/** The lease is held: the deadline clock runs from the first mutation. */
interface HeldExecution {
  readonly safety: ExecutionSafety;
  readonly started_at: UtcMillis;
}

/**
 * Runs one admitted run, variant validation or transport probe through P1-P9.
 *
 * @example
 * const runner = new ExecutionRunner(admitted, deps);
 * process.once('SIGINT', () => runner.abort('SIGINT'));
 * const outcome = await runner.runProbe(); // or runValidation(), runCanonical()
 */
export class ExecutionRunner {
  readonly #admitted: AdmittedExecution;
  readonly #deps: ExecutionRunnerDeps;
  readonly #gate: ExecutionGate;
  readonly #journal: ExecutionPhaseJournal;
  readonly #pkg: ExecutionPackage;
  readonly #monitor: LateEvidenceMonitor;
  readonly #reasons: StructuredReason[] = [];
  #workload: WorkloadOutcome = { completed: false, trials: [], reasons: [] };
  #interruptionJournaled = false;

  constructor(admitted: AdmittedExecution, deps: ExecutionRunnerDeps) {
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
   * `probe execute`: runs an admitted transport probe; any other kind is refused before any mutation.
   *
   * @example
   * (await runner.runProbe()).probe?.kind; // 'frozen'
   */
  runProbe(): Promise<ExecutionOutcome> {
    return this.#runAs('TRANSPORT_PROBE');
  }

  /**
   * `validation execute`: runs an admitted variant validation; any other kind is refused.
   *
   * @example
   * (await runner.runValidation()).trials.length; // 2
   */
  runValidation(): Promise<ExecutionOutcome> {
    return this.#runAs('VARIANT_VALIDATION');
  }

  /**
   * `run execute`: runs an admitted canonical run; any other kind is refused.
   *
   * @example
   * (await runner.runCanonical()).trials.length; // 4
   */
  runCanonical(): Promise<ExecutionOutcome> {
    return this.#runAs('RUN');
  }

  /**
   * Runs the execution, whatever its kind, to its finalized package; never throws on a port failure.
   *
   * @example
   * (await runner.run()).package_finalized; // true once package-index.json was written last
   */
  async run(): Promise<ExecutionOutcome> {
    const held = await this.#acquireLease();
    if (!('safety' in held)) {
      return this.#finalize(undefined, held);
    }
    const { safety } = held;
    const provisioned = await this.#provision();
    const mode =
      provisioned.targets === undefined
        ? 'EMERGENCY'
        : await this.#execute(provisioned.resource_manifest_sha256, provisioned.targets);
    safety.markActiveEnded();
    const cleanup = await this.#cleanUp(mode, provisioned, held);
    const leaseStatus = await this.#finalizeLease(closureOf(cleanup));
    return this.#finalize(safety, { ...(cleanup === undefined ? {} : { cleanup }), lease_status: leaseStatus });
  }

  // The command names the kind it runs; a mismatched package is refused before anything happens.
  async #runAs(kind: ExecutionKind): Promise<ExecutionOutcome> {
    const admittedKind = this.#admitted.identity.execution_kind;
    if (admittedKind === kind) {
      return this.run();
    }
    return {
      package_finalized: false,
      trials: [],
      reasons: [
        {
          code: 'EXECUTION_KIND_MISMATCH',
          subject: 'BR-RUA-040',
          detail: `${this.#admitted.package_directory} admits a ${admittedKind}; expected a ${kind} for this command`,
        },
      ],
    };
  }

  // P1. An abort that came before the first mutation stops the execution without one. An
  // unresolved acquisition (an ambiguous write whose resolving read failed) may hold the lease, so
  // it is finalized: a landed put must not stay HELD without a heartbeat (WP-22 residual 1).
  async #acquireLease(): Promise<HeldExecution | Closure> {
    await this.#journal.phase('LEASE_ACQUISITION', 'started');
    const aborted = await this.#noteInterruption();
    if (aborted !== undefined) {
      await this.#journal.phase('LEASE_ACQUISITION', 'skipped', [interruptionReason(aborted)]);
      return {};
    }
    const { services } = this.#deps;
    const startedNs = services.monotonic.nowNs();
    const startedAt = formatUtcMillis(services.clock.now());
    const acquisition = await this.#deps.lease.acquire();
    if (!acquisition.acquired) {
      await this.#journal.phase('LEASE_ACQUISITION', 'failed', [acquisition.reason]);
      const unresolved = acquisition.reason.code === LEASE_REASON_CODES.writeAmbiguous;
      return unresolved ? { lease_status: await this.#finalizeLease('clean') } : {};
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

  // P3, P4 (and P5) and P6; the cleanup mode they leave. Monitoring is active time: the
  // active-time deadline interrupts it like a unit, so the ACTIVE_TIME check measures it too
  // (`run` ends active time just before cleanup).
  async #execute(resourceManifestSha256: Sha256Hex, targets: ExecutionTargets): Promise<CleanupMode> {
    const ready = await this.#ready(targets);
    if (ready) {
      this.#workload = await this.#workloadOf().run(this.#workloadContext(resourceManifestSha256, targets));
    }
    this.#reasons.push(...this.#workload.reasons);
    if (!this.#workload.completed) {
      await this.#journal.phase('LATE_MONITORING', 'skipped', [this.#stopReason()]);
      return 'EMERGENCY';
    }
    await this.#journal.phase('LATE_MONITORING', 'started');
    const monitoring = await this.#monitor.observe(this.#gate);
    // Journaled before the outcome is judged: a shortened window means an interruption no unit
    // recorded, and without its `trial_interrupted` the summary would read it as COMPLETED.
    const interruption = await this.#noteInterruption();
    if (monitoring.outcome !== 'complete' || interruption !== undefined) {
      await this.#journal.phase('LATE_MONITORING', 'failed', [this.#stopReason()]);
      return 'EMERGENCY';
    }
    await this.#journal.phase('LATE_MONITORING', 'succeeded');
    return 'NORMAL';
  }

  // P3; false when the execution must not run its workload.
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

  #workloadOf(): ExecutionWorkload {
    const { identity } = this.#admitted;
    if (identity.execution_kind === 'TRANSPORT_PROBE') {
      return new ProbeWorkload(identity, this.#deps.probe, this.#deps.evidence.files);
    }
    return new TrialWorkload({ ...this.#admitted, identity }, this.#deps.trials);
  }

  #workloadContext(resourceManifestSha256: Sha256Hex, targets: ExecutionTargets): WorkloadContext {
    return {
      admitted: this.#admitted,
      resource_manifest_sha256: resourceManifestSha256,
      targets,
      gate: this.#gate,
      journal: this.#journal,
      services: this.#deps.services,
      noteInterruption: () => this.#noteInterruption(),
      unitRecordedInterruption: (): void => {
        this.#interruptionJournaled = true;
      },
    };
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
      pkg: this.#pkg,
      monitor: this.#monitor,
      capture: { store: readers.store, dlq: readers.dlq, durable: readers.durable },
      targets: provisioned.targets,
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
  async #finalizeLease(closure: LeaseClosure): Promise<LeaseStatus> {
    this.#deps.lease.stopHeartbeats();
    await this.#journal.phase('LEASE_FINALIZATION', 'started');
    const status = await this.#deps.lease.finalize(closure);
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
    const { probe } = this.#workload;
    return {
      package_finalized: index.ok,
      ...(interruption === undefined ? {} : { interruption }),
      trials: [...this.#workload.trials],
      ...(probe === undefined ? {} : { probe }),
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

  // Records, once, an interruption no unit recorded; the interruption, when there is one.
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

// Clean only when the closure is also frozen in the package: a release must be provable.
function closureOf(cleanup: CleanupRunOutcome | undefined): LeaseClosure {
  const clean =
    cleanup?.cleanup_result.cleanup_status === 'succeeded' &&
    cleanup.leak_audit_result.leak_audit_status === 'clean' &&
    cleanup.freeze.status === 'succeeded';
  return clean ? 'clean' : 'unclean';
}

/** Where the runner's cleanup evidence lands inside the package. */
const CLEANUP_PACKAGE_PATHS = {
  pre_cleanup_snapshot: EXECUTION_PATHS.preCleanupSnapshot,
  cleanup_result: EXECUTION_PATHS.cleanupResult,
  leak_audit_result: EXECUTION_PATHS.leakAuditResult,
} as const;
