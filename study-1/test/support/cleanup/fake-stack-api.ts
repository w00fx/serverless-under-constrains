// The offline CloudFormation stack of one execution (design §12.2 `FakeStackApi`). A deletion
// request moves the stack to DELETE_IN_PROGRESS; each later describe advances it:
// - while any durable execution runs, the deletion stays blocked (RK-10);
// - with `failDeletionRetaining(keys)`, the next deletion ends DELETE_FAILED and only the
//   retained members survive (CloudFormation retries delete them on the next request);
// - otherwise it ends DELETE_COMPLETE, and the stack and every member leave the surfaces.
// A deleted stack described by name fails, as CloudFormation answers "does not exist"; described
// by its id it still reads DELETE_COMPLETE.

import type { StackApi, StackDeleteRequest, StackRead } from '../../../src/cleanup/cleanup-ports.ts';
import { resourceKey } from '../../../src/cleanup/resource-names.ts';
import { STACK_RESOURCE_TYPE } from '../../../src/cleanup/resource-types.ts';
import type { RecordingMutationLog } from '../kernel/recording-mutation-log.ts';
import type { FakeDurableExecutions } from './fake-durable-executions.ts';
import type { StubDiscoverySurfaces } from './stub-discovery-surfaces.ts';

export interface FakeStackOptions {
  readonly stackId: string;
  readonly stackName: string;
  /** `resourceKey` of every resource the stack manages. */
  readonly memberKeys: readonly string[];
  /** False for a stack that was never created. */
  readonly exists?: boolean;
}

type StackStatus = 'CREATE_COMPLETE' | 'DELETE_IN_PROGRESS' | 'DELETE_FAILED' | 'DELETE_COMPLETE';

/**
 * One CloudFormation stack over the stub account.
 *
 * @example
 * const stack = new FakeStackApi(surfaces, executions, log, { stackId: STACK_ID, stackName: STACK_NAME, memberKeys });
 * await stack.requestDelete(STACK_ID);
 * await stack.describe(STACK_ID); // { kind: 'present', status: 'DELETE_COMPLETE' }
 */
export class FakeStackApi implements StackApi {
  readonly #surfaces: StubDiscoverySurfaces;
  readonly #executions: FakeDurableExecutions;
  readonly #log: RecordingMutationLog;
  readonly #options: FakeStackOptions;
  #status: StackStatus | 'absent';
  #retained: ReadonlySet<string> | undefined;
  #requestFailure = false;
  #describeFailure = false;
  #blockedReads = 0;

  constructor(
    surfaces: StubDiscoverySurfaces,
    executions: FakeDurableExecutions,
    log: RecordingMutationLog,
    options: FakeStackOptions,
  ) {
    this.#surfaces = surfaces;
    this.#executions = executions;
    this.#log = log;
    this.#options = options;
    this.#status = options.exists === false ? 'absent' : 'CREATE_COMPLETE';
  }

  /** The next deletion fails, leaving these members in place. */
  failDeletionRetaining(keys: readonly string[]): void {
    this.#retained = new Set(keys);
  }

  /** Every deletion request fails. */
  failDeleteRequests(): void {
    this.#requestFailure = true;
  }

  /** Every describe fails. */
  failDescribe(): void {
    this.#describeFailure = true;
  }

  status(): StackStatus | 'absent' {
    return this.#status;
  }

  /** Describes that found the deletion blocked by a running durable execution. */
  blockedReads(): number {
    return this.#blockedReads;
  }

  describe(stackIdOrName: string): Promise<StackRead> {
    if (this.#describeFailure) {
      return Promise.resolve(failedRead(stackIdOrName, 'scripted describe failure'));
    }
    if (stackIdOrName !== this.#options.stackId && stackIdOrName !== this.#options.stackName) {
      return Promise.resolve({ kind: 'absent' });
    }
    if (this.#status === 'DELETE_IN_PROGRESS') {
      this.#advanceDeletion();
    }
    if (this.#status === 'absent') {
      return Promise.resolve({ kind: 'absent' });
    }
    if (this.#status === 'DELETE_COMPLETE' && stackIdOrName === this.#options.stackName) {
      return Promise.resolve(failedRead(stackIdOrName, `Stack with id ${stackIdOrName} does not exist`));
    }
    return Promise.resolve({ kind: 'present', status: this.#status });
  }

  requestDelete(stackId: string): Promise<StackDeleteRequest> {
    this.#log.record({ port: 'cloudformation', operation: 'DeleteStack', target: stackId });
    if (this.#requestFailure) {
      return Promise.resolve({
        kind: 'failed',
        reason: {
          code: 'ValidationError',
          subject: stackId,
          detail: 'scripted DeleteStack failure; expected the request accepted',
        },
      });
    }
    if (this.#status === 'CREATE_COMPLETE' || this.#status === 'DELETE_FAILED') {
      this.#status = 'DELETE_IN_PROGRESS';
    }
    return Promise.resolve({ kind: 'requested' });
  }

  #advanceDeletion(): void {
    if (this.#executions.runningCount() > 0) {
      this.#blockedReads += 1;
      return;
    }
    const retained = this.#retained ?? new Set<string>();
    this.#retained = undefined;
    for (const key of this.#options.memberKeys.filter((member) => !retained.has(member))) {
      this.#surfaces.remove(key);
    }
    if (retained.size > 0) {
      this.#status = 'DELETE_FAILED';
      return;
    }
    this.#surfaces.remove(resourceKey({ resource_type: STACK_RESOURCE_TYPE, identifier: this.#options.stackId }));
    this.#status = 'DELETE_COMPLETE';
  }
}

function failedRead(subject: string, detail: string): StackRead {
  return {
    kind: 'failed',
    reason: { code: 'ValidationError', subject, detail: `${detail}; expected a stack description` },
  };
}
