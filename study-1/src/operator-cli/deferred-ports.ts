// The ports of one execution that are addressed by what P2 deployed (design §10.2 P2-P7; see
// `deployment-latch.ts`): each one builds its production adapter from the latched stack on first
// use and keeps it for the latched value. A port used before P2 latched what it needs (in practice
// never: the runner reaches P3 only with targets, and cleanup only with a frozen manifest) answers
// with its own failure value naming the missing target, so every caller's existing failure path
// handles it and nothing throws:
// - warm-up Invoke: a transport error (no response, so never a warm provider);
// - probe workload Invoke: a definitive rejection (the probe caller never ran);
// - telemetry lookup: a read failure (the signal is `unavailable`, diagnostics only);
// - Durable executions, DLQ deletion, discovery: a failed listing, stop, deletion or query, which
//   cleanup records and the leak audit turns into `inconclusive`, never `clean`.

import type { DiscoveredResource, DiscoverySurfaces, PresenceCheck, SurfaceQueryResult } from '../cleanup/discovery.ts';
import type { DiscoveryTargets } from '../cleanup/discovery-targets.ts';
import { discoveryTargetsOf } from '../cleanup/discovery-targets.ts';
import type {
  DlqDeletionReport,
  DlqMessagePort,
  DurableExecutionListing,
  DurableExecutionPort,
  DurableStopOutcome,
} from '../cleanup/cleanup-ports.ts';
import type { CaptureScope } from '../evidence-collection/capture-scope.ts';
import type { CollectorReadFailure } from '../evidence-collection/collected-records.ts';
import type { TelemetryProbe } from '../evidence-collection/telemetry-availability.ts';
import type { TelemetrySignal } from '../evidence-collection/telemetry-availability.ts';
import type { ExecutionTargets, ProbeCallerOutputs } from '../execution-lifecycle/execution-ports.ts';
import type { ProviderTransportResult } from '../provider-client/provider-invocation-port.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { ExecutionIdentity, Result, StructuredReason } from '../record-contract/primitives.ts';
import type { LeakAuditSurface } from '../record-contract/records/group-c/vocabulary.ts';
import type { ProbeWorkloadRequest } from '../record-contract/records/group-a/probe_workload_request.ts';
import type { ProviderWarmupRequest } from '../record-contract/records/group-b/provider_warmup_request.ts';
import type {
  ProbeWorkloadInvokeResult,
  ProbeWorkloadInvoker,
  ProviderWarmupInvoker,
} from '../trial-execution/trial-execution-ports.ts';
import type { DeployedStack, DeploymentLatch } from './deployment-latch.ts';

/** The provider's published version the warm-up invokes. */
export interface ProviderWarmupTarget {
  readonly function_name: string;
  readonly qualifier: string;
}

/** The cleanup adapters bound to one execution's discovery targets. */
export interface TargetedCleanupPorts {
  readonly durableExecutions: DurableExecutionPort;
  readonly dlq: DlqMessagePort;
  readonly surfaces: DiscoverySurfaces;
}

/** How each production adapter is built once its target is known (production: AWS). */
export interface DeferredPortFactories {
  readonly warmup: (target: ProviderWarmupTarget) => ProviderWarmupInvoker;
  readonly workload: (target: ProbeCallerOutputs) => ProbeWorkloadInvoker;
  readonly telemetry: (functionNames: ExecutionTargets['function_names']) => TelemetryProbe;
  readonly cleanup: (targets: DiscoveryTargets) => TargetedCleanupPorts;
}

/** Every deferred port of one execution. */
export interface DeferredExecutionPorts extends TargetedCleanupPorts {
  readonly warmup: ProviderWarmupInvoker;
  readonly workload: ProbeWorkloadInvoker;
  readonly telemetry: TelemetryProbe;
}

const SUBJECT = 'BR-RUA-050';

/**
 * A port built from the latched stack on first use, rebuilt only if the latch changes.
 *
 * @example
 * const binding = new DeferredBinding(latch, 'warm-up Invoke', (deployed) => warmupOf(deployed, factory));
 * binding.port(); // err(TARGET_NOT_DEPLOYED) before P2 latched a stack
 */
export class DeferredBinding<T> {
  readonly #latch: DeploymentLatch;
  readonly #name: string;
  readonly #build: (deployed: DeployedStack) => Result<T, StructuredReason>;
  #built: { readonly from: DeployedStack; readonly port: Result<T, StructuredReason> } | undefined;

  constructor(latch: DeploymentLatch, name: string, build: (deployed: DeployedStack) => Result<T, StructuredReason>) {
    this.#latch = latch;
    this.#name = name;
    this.#build = build;
  }

  port(): Result<T, StructuredReason> {
    const deployed = this.#latch.deployed();
    if (deployed === undefined) {
      return err(targetReason(`the ${this.#name} has no deployed stack yet`, 'a resource manifest frozen at P2'));
    }
    if (this.#built?.from !== deployed) {
      this.#built = { from: deployed, port: this.#build(deployed) };
    }
    return this.#built.port;
  }
}

/**
 * Binds every deferred port of `execution` to the latch.
 *
 * @example
 * const ports = deferredExecutionPorts(latch, admitted.identity, awsFactories);
 * new TrialExecutor({ ...deps, warmup: ports.warmup, telemetry: ports.telemetry });
 */
export function deferredExecutionPorts(
  latch: DeploymentLatch,
  execution: ExecutionIdentity,
  factories: DeferredPortFactories,
): DeferredExecutionPorts {
  const cleanup = new DeferredBinding(latch, 'cleanup discovery', (deployed) => {
    const targets = discoveryTargetsOf({ manifest: deployed.resource_manifest, execution });
    return targets.ok ? ok(factories.cleanup(targets.value)) : targets;
  });
  return {
    warmup: new DeferredWarmupInvoker(
      new DeferredBinding(latch, 'warm-up Invoke', (deployed) => {
        const name = deployed.targets?.provider_function_name;
        const version = deployed.targets?.provider_version;
        return name === undefined || version === undefined
          ? err(
              targetReason(
                'the stack outputs name no provider function and version',
                'ProviderFunctionName and ProviderVersion',
              ),
            )
          : ok(factories.warmup({ function_name: name, qualifier: version }));
      }),
    ),
    workload: new DeferredProbeWorkloadInvoker(
      new DeferredBinding(latch, 'probe workload Invoke', (deployed) => {
        const caller = deployed.targets?.probe_caller;
        return caller === undefined
          ? err(
              targetReason('the stack outputs name no probe caller', 'ProbeCallerFunctionName and ProbeCallerVersion'),
            )
          : ok(factories.workload(caller));
      }),
    ),
    telemetry: new DeferredTelemetryProbe(
      new DeferredBinding(latch, 'telemetry lookup', (deployed) =>
        deployed.targets === undefined
          ? err(targetReason('the deploy named no targets', 'the targets of a successful deploy'))
          : ok(factories.telemetry(deployed.targets.function_names)),
      ),
    ),
    durableExecutions: new DeferredDurableExecutions(cleanup),
    dlq: new DeferredDlqMessages(cleanup),
    surfaces: new DeferredDiscoverySurfaces(cleanup),
  };
}

class DeferredWarmupInvoker implements ProviderWarmupInvoker {
  readonly #binding: DeferredBinding<ProviderWarmupInvoker>;

  constructor(binding: DeferredBinding<ProviderWarmupInvoker>) {
    this.#binding = binding;
  }

  invokeWarmup(request: ProviderWarmupRequest): Promise<ProviderTransportResult> {
    const port = this.#binding.port();
    return port.ok
      ? port.value.invokeWarmup(request)
      : Promise.resolve({ kind: 'transport_error', error_name: port.error.code, message: port.error.detail });
  }
}

class DeferredProbeWorkloadInvoker implements ProbeWorkloadInvoker {
  readonly #binding: DeferredBinding<ProbeWorkloadInvoker>;

  constructor(binding: DeferredBinding<ProbeWorkloadInvoker>) {
    this.#binding = binding;
  }

  invokeWorkload(request: ProbeWorkloadRequest): Promise<ProbeWorkloadInvokeResult> {
    const port = this.#binding.port();
    return port.ok
      ? port.value.invokeWorkload(request)
      : Promise.resolve({ kind: 'rejected', code: port.error.code, detail: port.error.detail });
  }
}

class DeferredTelemetryProbe implements TelemetryProbe {
  readonly #binding: DeferredBinding<TelemetryProbe>;

  constructor(binding: DeferredBinding<TelemetryProbe>) {
    this.#binding = binding;
  }

  locate(signal: TelemetrySignal, scope: CaptureScope): Promise<Result<readonly string[], CollectorReadFailure>> {
    const port = this.#binding.port();
    return port.ok ? port.value.locate(signal, scope) : Promise.resolve(err({ code: port.error.code }));
  }
}

class DeferredDurableExecutions implements DurableExecutionPort {
  readonly #binding: DeferredBinding<TargetedCleanupPorts>;

  constructor(binding: DeferredBinding<TargetedCleanupPorts>) {
    this.#binding = binding;
  }

  listRunning(functionName: string): Promise<DurableExecutionListing> {
    const port = this.#binding.port();
    return port.ok
      ? port.value.durableExecutions.listRunning(functionName)
      : Promise.resolve({ ok: false, reason: port.error });
  }

  stop(executionArn: string): Promise<DurableStopOutcome> {
    const port = this.#binding.port();
    return port.ok
      ? port.value.durableExecutions.stop(executionArn)
      : Promise.resolve({ kind: 'failed', reason: port.error });
  }
}

class DeferredDlqMessages implements DlqMessagePort {
  readonly #binding: DeferredBinding<TargetedCleanupPorts>;

  constructor(binding: DeferredBinding<TargetedCleanupPorts>) {
    this.#binding = binding;
  }

  deleteCaptured(messageIds: readonly string[]): Promise<DlqDeletionReport> {
    const port = this.#binding.port();
    if (port.ok) {
      return port.value.dlq.deleteCaptured(messageIds);
    }
    const failed = messageIds.map((id) => ({ message_id: id, reason: port.error }));
    return Promise.resolve({ deleted: [], absent: [], failed });
  }
}

class DeferredDiscoverySurfaces implements DiscoverySurfaces {
  readonly #binding: DeferredBinding<TargetedCleanupPorts>;

  constructor(binding: DeferredBinding<TargetedCleanupPorts>) {
    this.#binding = binding;
  }

  query(surface: LeakAuditSurface): Promise<SurfaceQueryResult> {
    const port = this.#binding.port();
    return port.ok ? port.value.surfaces.query(surface) : Promise.resolve({ ok: false, reason: port.error });
  }

  confirmPresence(resource: DiscoveredResource): Promise<PresenceCheck> {
    const port = this.#binding.port();
    return port.ok
      ? port.value.surfaces.confirmPresence(resource)
      : Promise.resolve({ kind: 'failed', reason: port.error });
  }
}

function targetReason(problem: string, expected: string): StructuredReason {
  return { code: 'TARGET_NOT_DEPLOYED', subject: SUBJECT, detail: `${problem}; expected ${expected}` };
}
