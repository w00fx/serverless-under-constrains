// FakePostDeployReader (design §12.2): the PostDeployReader port over an in-memory deployed account.
// It answers what the production reader answers over the real SDK clients for the same account,
// which `aws/fake-post-deploy-reader.conformance.integration.test.ts` proves differentially:
// - each call hands the stored SDK output to the same total mapper the adapter uses;
// - a stack that does not exist describes as `undefined` (CloudFormation's ValidationError);
// - ListStackResources answers `page_size` summaries per page with an opaque next token;
// - a missing function, mapping, queue or table fails with the service's error name;
// - a version or alias without provisioned concurrency reads as absent.
// Test hooks, outside the port: `failWith(method, failure)` makes every later call of that method
// fail; `calls()` lists every call in order.

import { err, ok } from '../../../src/record-contract/primitives.ts';
import type { Result } from '../../../src/record-contract/primitives.ts';
import {
  absentProvisionedConcurrency,
  eventSourceMappingOf,
  functionConfigurationOf,
  provisionedConcurrencyOf,
  queueAttributesOf,
  stackDescriptionOf,
  stackResourcePageOf,
  tableDescriptionOf,
} from '../../../src/deployment-assembly/post-deploy-reading.ts';
import type {
  AttributeReading,
  PostDeployReader,
  PostDeployReadFailure,
  StackResourcePage,
} from '../../../src/deployment-assembly/post-deploy-reading.ts';
import type { StackDescription } from '../../../src/deployment-assembly/resource-manifest.ts';
import type { DeployedAccount } from './deployed-account.ts';

export type PostDeployReadMethod = keyof PostDeployReader;

/** One port call: the method and its arguments. */
export interface RecordedPostDeployRead {
  readonly method: PostDeployReadMethod;
  readonly args: readonly string[];
}

const PAGE_TOKEN_PREFIX = 'page-';

/** The error a missing resource answers with, as the Lambda, SQS and DynamoDB APIs name it. */
export const MISSING_RESOURCE_FAILURES = {
  readFunctionConfiguration: (name: string): PostDeployReadFailure => ({
    code: 'ResourceNotFoundException',
    detail: `Function not found: ${name}`,
  }),
  readEventSourceMapping: (uuid: string): PostDeployReadFailure => ({
    code: 'ResourceNotFoundException',
    detail: `The resource you requested does not exist. (Service: Lambda, UUID: ${uuid})`,
  }),
  readQueueAttributes: (): PostDeployReadFailure => ({
    code: 'QueueDoesNotExist',
    detail: 'The specified queue does not exist.',
  }),
  readTable: (name: string): PostDeployReadFailure => ({
    code: 'ResourceNotFoundException',
    detail: `Requested resource not found: Table: ${name} not found`,
  }),
  listStackResources: (stack: string): PostDeployReadFailure => ({
    code: 'ValidationError',
    detail: `Stack with id ${stack} does not exist`,
  }),
} as const;

export class FakePostDeployReader implements PostDeployReader {
  readonly #account: DeployedAccount;
  readonly #failures = new Map<PostDeployReadMethod, PostDeployReadFailure>();
  readonly #calls: RecordedPostDeployRead[] = [];

  constructor(account: DeployedAccount) {
    this.#account = account;
  }

  /** Every later call of `method` fails with `failure`. */
  failWith(method: PostDeployReadMethod, failure: PostDeployReadFailure): void {
    this.#failures.set(method, failure);
  }

  /** Every call so far, in order. */
  calls(): readonly RecordedPostDeployRead[] {
    return [...this.#calls];
  }

  describeStack(stackName: string): Promise<Result<StackDescription | undefined, PostDeployReadFailure>> {
    const failure = this.#take('describeStack', [stackName]);
    const stack = this.#stackNamed(stackName) ? this.#account.stack : undefined;
    if (failure !== undefined || stack === undefined) {
      return Promise.resolve(failure === undefined ? ok(undefined) : err(failure));
    }
    return Promise.resolve(stackDescriptionOf({ Stacks: [stack] }));
  }

  listStackResources(stack: string, nextToken?: string): Promise<Result<StackResourcePage, PostDeployReadFailure>> {
    const failure = this.#take('listStackResources', nextToken === undefined ? [stack] : [stack, nextToken]);
    if (failure !== undefined || !this.#stackNamed(stack)) {
      return Promise.resolve(err(failure ?? MISSING_RESOURCE_FAILURES.listStackResources(stack)));
    }
    const page = nextToken === undefined ? 0 : Number(nextToken.slice(PAGE_TOKEN_PREFIX.length));
    const size = this.#account.page_size;
    const summaries = this.#account.resources.slice(page * size, (page + 1) * size);
    const more = (page + 1) * size < this.#account.resources.length;
    const output = { StackResourceSummaries: summaries, ...(more ? { NextToken: pageToken(page + 1) } : {}) };
    return Promise.resolve(stackResourcePageOf(output));
  }

  readFunctionConfiguration(
    functionName: string,
    qualifier: string,
  ): Promise<Result<readonly AttributeReading[], PostDeployReadFailure>> {
    const key = `${functionName}:${qualifier}`;
    const failure = this.#take('readFunctionConfiguration', [functionName, qualifier]);
    const output = this.#account.functions[key];
    return Promise.resolve(
      answer(failure, output, functionConfigurationOf, MISSING_RESOURCE_FAILURES.readFunctionConfiguration(key)),
    );
  }

  readEventSourceMapping(uuid: string): Promise<Result<readonly AttributeReading[], PostDeployReadFailure>> {
    const failure = this.#take('readEventSourceMapping', [uuid]);
    const output = this.#account.mappings[uuid];
    return Promise.resolve(
      answer(failure, output, eventSourceMappingOf, MISSING_RESOURCE_FAILURES.readEventSourceMapping(uuid)),
    );
  }

  readProvisionedConcurrency(
    functionName: string,
    qualifier: string,
  ): Promise<Result<readonly AttributeReading[], PostDeployReadFailure>> {
    const failure = this.#take('readProvisionedConcurrency', [functionName, qualifier]);
    const output = this.#account.concurrency[`${functionName}:${qualifier}`];
    if (failure !== undefined) {
      return Promise.resolve(err(failure));
    }
    return Promise.resolve(
      output === undefined ? ok(absentProvisionedConcurrency()) : provisionedConcurrencyOf(output),
    );
  }

  readQueueAttributes(queueUrl: string): Promise<Result<readonly AttributeReading[], PostDeployReadFailure>> {
    const failure = this.#take('readQueueAttributes', [queueUrl]);
    const attributes = this.#account.queues[queueUrl];
    const output = attributes === undefined ? undefined : { Attributes: attributes };
    return Promise.resolve(answer(failure, output, queueAttributesOf, MISSING_RESOURCE_FAILURES.readQueueAttributes()));
  }

  readTable(tableName: string): Promise<Result<readonly AttributeReading[], PostDeployReadFailure>> {
    const failure = this.#take('readTable', [tableName]);
    const table = this.#account.tables[tableName];
    const output = table === undefined ? undefined : { Table: table };
    return Promise.resolve(answer(failure, output, tableDescriptionOf, MISSING_RESOURCE_FAILURES.readTable(tableName)));
  }

  #take(method: PostDeployReadMethod, args: readonly string[]): PostDeployReadFailure | undefined {
    this.#calls.push({ method, args });
    return this.#failures.get(method);
  }

  // DescribeStacks and ListStackResources accept the stack's name or its id.
  #stackNamed(stack: string): boolean {
    const described = this.#account.stack;
    return described !== undefined && (stack === this.#account.stack_name || stack === described['StackId']);
  }
}

function answer<T>(
  failure: PostDeployReadFailure | undefined,
  output: object | undefined,
  mapper: (output: unknown) => Result<T, PostDeployReadFailure>,
  missing: PostDeployReadFailure,
): Result<T, PostDeployReadFailure> {
  if (failure !== undefined) {
    return err(failure);
  }
  return output === undefined ? err(missing) : mapper(output);
}

/**
 * The opaque token of ListStackResources page `page` (0-based), as both fakes hand it out.
 *
 * @example
 * pageToken(1); // 'page-1'
 */
export function pageToken(page: number): string {
  return `${PAGE_TOKEN_PREFIX}${String(page)}`;
}
