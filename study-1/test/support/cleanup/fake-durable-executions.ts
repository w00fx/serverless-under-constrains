// The offline Lambda durable executions (design §12.2, RK-10): running executions of the run's
// durable functions, listed on the `durable_executions` surface while they run. Stopping one
// removes it from the surface. `FakeStackApi` reads `runningCount()` to keep a stack deletion
// blocked while any execution runs, as CloudFormation does for up to an hour.

import type {
  DurableExecutionListing,
  DurableExecutionPort,
  DurableStopOutcome,
} from '../../../src/cleanup/cleanup-ports.ts';
import { resourceKey } from '../../../src/cleanup/resource-names.ts';
import { DURABLE_EXECUTION_RESOURCE_TYPE } from '../../../src/cleanup/resource-types.ts';
import type { RecordingMutationLog } from '../kernel/recording-mutation-log.ts';
import type { StubDiscoverySurfaces } from './stub-discovery-surfaces.ts';

/**
 * Running durable executions per function, mirrored on the stub `durable_executions` surface.
 *
 * @example
 * const executions = new FakeDurableExecutions(surfaces, log, STACK_ID);
 * executions.start('suc1-aaaaaaaa-durable-caller', 'arn:…:durable-execution/1');
 * await executions.stop('arn:…:durable-execution/1'); // { kind: 'stopped' }
 */
export class FakeDurableExecutions implements DurableExecutionPort {
  readonly #surfaces: StubDiscoverySurfaces;
  readonly #log: RecordingMutationLog;
  readonly #stackId: string;
  readonly #running = new Map<string, string>();
  readonly #listFailures = new Set<string>();
  readonly #stopFailures = new Set<string>();
  readonly #endingAfterListing = new Set<string>();

  constructor(surfaces: StubDiscoverySurfaces, log: RecordingMutationLog, stackId: string) {
    this.#surfaces = surfaces;
    this.#log = log;
    this.#stackId = stackId;
  }

  /** Starts a RUNNING execution of `functionName`. */
  start(functionName: string, executionArn: string): void {
    this.#running.set(executionArn, functionName);
    this.#surfaces.place({
      resource_type: DURABLE_EXECUTION_RESOURCE_TYPE,
      identifier: executionArn,
      surface: 'durable_executions',
      tags: { kind: 'untaggable' },
      managed_by_stack_id: this.#stackId,
    });
  }

  /** Listing the executions of this function fails. */
  failList(functionName: string): void {
    this.#listFailures.add(functionName);
  }

  /** Stopping this execution fails. */
  failStop(executionArn: string): void {
    this.#stopFailures.add(executionArn);
  }

  /** The execution ends on its own right after the next listing returns it (a stop then finds it ended). */
  endAfterListing(executionArn: string): void {
    this.#endingAfterListing.add(executionArn);
  }

  runningCount(): number {
    return this.#running.size;
  }

  listRunning(functionName: string): Promise<DurableExecutionListing> {
    if (this.#listFailures.has(functionName)) {
      return Promise.resolve({
        ok: false,
        reason: {
          code: 'ServiceException',
          subject: functionName,
          detail: 'scripted listing failure; expected a listing',
        },
      });
    }
    const arns = [...this.#running].filter(([, owner]) => owner === functionName).map(([arn]) => arn);
    for (const arn of arns.filter((listed) => this.#endingAfterListing.has(listed))) {
      this.#end(arn);
    }
    return Promise.resolve({ ok: true, running_execution_arns: arns.sort() });
  }

  stop(executionArn: string): Promise<DurableStopOutcome> {
    this.#log.record({ port: 'lambda', operation: 'StopDurableExecution', target: executionArn });
    if (this.#stopFailures.has(executionArn)) {
      return Promise.resolve({
        kind: 'failed',
        reason: {
          code: 'ServiceException',
          subject: executionArn,
          detail: 'scripted stop failure; expected the execution stopped',
        },
      });
    }
    if (!this.#running.has(executionArn)) {
      return Promise.resolve({ kind: 'not_running' });
    }
    this.#end(executionArn);
    return Promise.resolve({ kind: 'stopped' });
  }

  #end(executionArn: string): void {
    this.#running.delete(executionArn);
    this.#endingAfterListing.delete(executionArn);
    this.#surfaces.remove(resourceKey({ resource_type: DURABLE_EXECUTION_RESOURCE_TYPE, identifier: executionArn }));
  }
}
