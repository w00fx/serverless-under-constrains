// Named fake of the production adapter factories the deferred ports build from (design §10.2
// P2-P7; production: `aws-execution-session.ts`): every build is recorded with the target it was
// given, and every built port answers a value that names the target it was bound to (never the
// unbound TARGET_NOT_DEPLOYED answer), so a test can tell which latched stack answered. The cleanup ports reuse the cleanup fakes
// (`FakeDurableExecutions`, `FakeDlqMessages`, `StubDiscoverySurfaces`) over one recording log; the
// telemetry probe is the collection tests' `ScriptedTelemetryProbe`. Its conformance test
// (`recording-port-factories.test.ts`) holds each built port to its interface's success answers.

import type { DiscoveryTargets } from '../../../../src/cleanup/discovery-targets.ts';
import type { ExecutionTargets, ProbeCallerOutputs } from '../../../../src/execution-lifecycle/execution-ports.ts';
import type {
  DeferredPortFactories,
  ProviderWarmupTarget,
  TargetedCleanupPorts,
} from '../../../../src/operator-cli/deferred-ports.ts';
import type { ProviderTransportResult } from '../../../../src/provider-client/provider-invocation-port.ts';
import type { ProbeWorkloadRequest } from '../../../../src/record-contract/records/group-a/probe_workload_request.ts';
import type { ProviderWarmupRequest } from '../../../../src/record-contract/records/group-b/provider_warmup_request.ts';
import type {
  ProbeWorkloadInvokeResult,
  ProbeWorkloadInvoker,
  ProviderWarmupInvoker,
} from '../../../../src/trial-execution/trial-execution-ports.ts';
import type { TelemetryProbe } from '../../../../src/evidence-collection/telemetry-availability.ts';
import { FakeDlqMessages } from '../../../support/cleanup/fake-dlq-messages.ts';
import { FakeDurableExecutions } from '../../../support/cleanup/fake-durable-executions.ts';
import { StubDiscoverySurfaces } from '../../../support/cleanup/stub-discovery-surfaces.ts';
import { ScriptedTelemetryProbe } from '../../../support/evidence-collection/scripted-telemetry-probe.ts';
import { RecordingMutationLog } from '../../../support/kernel/recording-mutation-log.ts';

/** One factory call: which port was built, for which target. */
export interface PortBuild {
  readonly port: 'warmup' | 'workload' | 'telemetry' | 'cleanup';
  readonly target: string;
}

/** The error name a bound warm-up answers with, distinct from TARGET_NOT_DEPLOYED. */
export const BOUND_WARMUP_ERROR = 'BoundWarmup';

/**
 * Factories that record each build and bind ports answering with their target.
 *
 * @example
 * const factories = new RecordingPortFactories();
 * deferredExecutionPorts(latch, identity, factories);
 * factories.builds; // [] until a port is used after P2 latched a stack
 */
export class RecordingPortFactories implements DeferredPortFactories {
  /** Every build, in order. */
  readonly builds: PortBuild[] = [];
  /** The cleanup ports of the last cleanup build. */
  cleanupPorts: TargetedCleanupPorts | undefined;

  readonly warmup = (target: ProviderWarmupTarget): ProviderWarmupInvoker => {
    const named = `${target.function_name}@${target.qualifier}`;
    this.builds.push({ port: 'warmup', target: named });
    return {
      invokeWarmup: (request: ProviderWarmupRequest): Promise<ProviderTransportResult> =>
        Promise.resolve({
          kind: 'transport_error',
          error_name: BOUND_WARMUP_ERROR,
          message: `${named} ${request.warmup_id}`,
        }),
    };
  };

  readonly workload = (target: ProbeCallerOutputs): ProbeWorkloadInvoker => {
    const named = `${target.function_name}@${target.version}`;
    this.builds.push({ port: 'workload', target: named });
    return {
      invokeWorkload: (request: ProbeWorkloadRequest): Promise<ProbeWorkloadInvokeResult> =>
        Promise.resolve({
          kind: 'response',
          status_code: 200,
          executed_version: target.version,
          payload: new TextEncoder().encode(request.transport_probe_id),
        }),
    };
  };

  readonly telemetry = (functionNames: ExecutionTargets['function_names']): TelemetryProbe => {
    this.builds.push({ port: 'telemetry', target: JSON.stringify(functionNames) });
    return new ScriptedTelemetryProbe({ logs: Object.values(functionNames) });
  };

  readonly cleanup = (targets: DiscoveryTargets): TargetedCleanupPorts => {
    this.builds.push({ port: 'cleanup', target: targets.stack_ref });
    const log = new RecordingMutationLog();
    const surfaces = new StubDiscoverySurfaces();
    const ports = {
      durableExecutions: new FakeDurableExecutions(surfaces, log, targets.stack_ref),
      dlq: new FakeDlqMessages(log),
      surfaces,
    };
    this.cleanupPorts = ports;
    return ports;
  };
}
