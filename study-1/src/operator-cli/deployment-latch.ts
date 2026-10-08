// What the composition learns while an execution runs (design §10.2 P2, P4): the runner takes
// every port when it is built, yet several production adapters can only be addressed once P2 has
// deployed the stack (the provider's and the probe caller's published versions, the deployed
// function names, the DLQ URLs and Durable functions cleanup acts on), and telemetry windows start
// when each unit starts. So the composition root binds:
// - a `DeploymentLatch`, which a `LatchingProvisioner` fills with the frozen resource manifest and
//   the stack's targets the moment P2 returns, for the deferred ports to read (`deferred-ports.ts`);
// - a `UnitStartRegistry`, which the trial and probe runner decorators fill as each unit starts,
//   for the telemetry lookups' windows (`TelemetryBinding.unit_started_at`).
// Nothing here decides anything about the execution: each decorator passes its call through.

import type {
  AdmittedExecution,
  ExecutionProvisioner,
  ExecutionTargets,
  ProbeRunner,
  ProvisioningOutcome,
  TrialRunner,
} from '../execution-lifecycle/execution-ports.ts';
import type { UtcMillis, WallClock } from '../record-contract/primitives.ts';
import type { ResourceManifest } from '../record-contract/records/group-a/resource_manifest.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type {
  CoordinationCheckpointWriter,
  ProbeExecutionReport,
  ProbeWorkloadPlan,
  PublicationGate,
  TrialExecutionReport,
  TrialPlan,
} from '../trial-execution/trial-execution-ports.ts';

/**
 * The key a probe's start instant is stored under: `telemetryUnit` names the probe unit `probe`
 * (evidence-collection/telemetry-targets.ts; a unit test pins the two together).
 */
export const PROBE_UNIT_START_KEY = 'probe';

/** What P2 froze: the resource manifest, and the targets once the deploy succeeded. */
export interface DeployedStack {
  readonly resource_manifest: ResourceManifest;
  readonly targets?: ExecutionTargets;
}

/**
 * Holds what P2 deployed for the ports that are addressed only afterwards.
 *
 * @example
 * const latch = new DeploymentLatch();
 * latch.deployed(); // undefined until P2 froze a resource manifest
 */
export class DeploymentLatch {
  #deployed: DeployedStack | undefined;

  /** Records a provisioning outcome; one that froze no resource manifest leaves the latch as it was. */
  record(outcome: ProvisioningOutcome): void {
    if (outcome.resource_manifest === undefined) {
      return;
    }
    const { resource_manifest: resourceManifest, targets } = outcome;
    this.#deployed =
      targets === undefined
        ? { resource_manifest: resourceManifest }
        : { resource_manifest: resourceManifest, targets };
  }

  /** What P2 froze, or undefined before it froze a resource manifest. */
  deployed(): DeployedStack | undefined {
    return this.#deployed;
  }
}

/**
 * P2 through `inner`, recording its outcome in the latch before the runner sees it.
 *
 * @example
 * new LatchingProvisioner(new FrozenAssemblyExecutionProvisioner(assembly), latch);
 */
export class LatchingProvisioner implements ExecutionProvisioner {
  readonly #inner: ExecutionProvisioner;
  readonly #latch: DeploymentLatch;

  constructor(inner: ExecutionProvisioner, latch: DeploymentLatch) {
    this.#inner = inner;
    this.#latch = latch;
  }

  async provision(admitted: AdmittedExecution): Promise<ProvisioningOutcome> {
    const outcome = await this.#inner.provision(admitted);
    this.#latch.record(outcome);
    return outcome;
  }
}

/**
 * The instant each unit started, by trial id or `probe`; the first start of a unit is kept.
 *
 * @example
 * const starts = new UnitStartRegistry(clock);
 * starts.record(trialId);
 * starts.view().get(trialId); // '2026-10-05T12:03:00.000Z'
 */
export class UnitStartRegistry {
  readonly #clock: WallClock;
  readonly #started = new Map<string, UtcMillis>();

  constructor(clock: WallClock) {
    this.#clock = clock;
  }

  record(unitKey: string): void {
    if (!this.#started.has(unitKey)) {
      this.#started.set(unitKey, formatUtcMillis(this.#clock.now()));
    }
  }

  /** A live view: later starts appear in it. */
  view(): ReadonlyMap<string, UtcMillis> {
    return this.#started;
  }
}

/**
 * The trial runner that records each trial's start before running it.
 *
 * @example
 * new StartRecordingTrialRunner(new TrialExecutor(deps), starts);
 */
export class StartRecordingTrialRunner implements TrialRunner {
  readonly #inner: TrialRunner;
  readonly #starts: UnitStartRegistry;

  constructor(inner: TrialRunner, starts: UnitStartRegistry) {
    this.#inner = inner;
    this.#starts = starts;
  }

  execute(plan: TrialPlan, gate: PublicationGate): Promise<TrialExecutionReport> {
    this.#starts.record(plan.trial.trial_id);
    return this.#inner.execute(plan, gate);
  }
}

/**
 * The probe runner that records the probe's start before running it.
 *
 * @example
 * new StartRecordingProbeRunner(new ExecutorProbeRunner(deps), starts);
 */
export class StartRecordingProbeRunner implements ProbeRunner {
  readonly #inner: ProbeRunner;
  readonly #starts: UnitStartRegistry;

  constructor(inner: ProbeRunner, starts: UnitStartRegistry) {
    this.#inner = inner;
    this.#starts = starts;
  }

  execute(
    plan: ProbeWorkloadPlan,
    gate: PublicationGate,
    checkpoint: CoordinationCheckpointWriter,
  ): Promise<ProbeExecutionReport> {
    this.#starts.record(PROBE_UNIT_START_KEY);
    return this.#inner.execute(plan, gate, checkpoint);
  }
}
