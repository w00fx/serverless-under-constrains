// The Durable variant end to end offline: the FIFO source (360 s visibility, DLQ after two
// receives) and the fake event source mapping invoke the real durable handler, which the SDK's
// LocalDurableTestRunner executes with its local checkpoint server, over the composed caller of
// `durable-harness.ts`. Each SQS delivery is one new durable execution (no ESM idempotency).
//
// Two clocks run here. The runner's retry delay is real time, so the handler is built with the
// injected 1 s delay (`TEST_RETRY`, RK-09) and `skipTime: false`; everything the caller times
// (provider deadlines, journal timestamps, SQS visibility) runs on the virtual clock, which the
// pump advances between short real sleeps. Each test file holds one test, because the runner's
// environment is process-global (RK-09).

import { setTimeout as sleep } from 'node:timers/promises';

import { LocalDurableTestRunner } from '@aws/durable-execution-sdk-js-testing';
import type { TestResult, TestResultError } from '@aws/durable-execution-sdk-js-testing';

import type { DurableRefundCaller, DurableStepResult } from '../../../../src/durable-variant/durable-refund-caller.ts';
import { createDurableRefundHandler } from '../../../../src/durable-variant/durable-refund-handler.ts';
import { DURABLE_STEP_ATTEMPTS } from '../../../../src/durable-variant/durable-retry.ts';
import type { DurableRetryConfig } from '../../../../src/durable-variant/durable-retry.ts';
import { FakeSqsEsmDriver } from '../../../support/fifo-queue/fake-sqs-esm-driver.ts';
import type { PollResult } from '../../../support/fifo-queue/fake-sqs-esm-driver.ts';
import { InMemoryFifoQueue } from '../../../support/fifo-queue/in-memory-fifo-queue.ts';
import { SequentialUuidSource } from '../../../support/kernel/sequential-uuid-source.ts';
import { TRIAL_ID, messageBody } from '../../../unit/trial-message/support/trial-message-fixtures.ts';
import type { DurableHarness, DurableHarnessOptions } from './durable-harness.ts';
import { durableHarness } from './durable-harness.ts';
import { RecordingDurableLogSink } from './recording-durable-log-sink.ts';

/** OR-RUA-002: the Durable source's visibility timeout. */
export const DURABLE_VISIBILITY_TIMEOUT_MS = 360_000;
export const DURABLE_SOURCE_ARN = 'arn:aws:sqs:us-east-1:123456789012:suc1-aaaaaaaa-durable-source.fifo';
/** The deployed attempt count with the 1 s test delay (RK-09); the 60 s value is a unit-tested constant. */
export const TEST_RETRY: DurableRetryConfig = { attempts: DURABLE_STEP_ATTEMPTS, delay_seconds: 1 };

const PUMP_SLEEP_MS = 5;
const PUMP_LIMIT_MS = 30_000;

/** The execution the mapping's invocation ended with, when it did not succeed. */
export class DurableExecutionNotSucceeded extends Error {
  readonly status: string | undefined;
  readonly failure: TestResultError | undefined;

  constructor(status: string | undefined, failure: TestResultError | undefined) {
    super(`durable execution ended ${String(status)}: ${String(failure?.errorType)}: ${String(failure?.errorMessage)}`);
    this.name = 'DurableExecutionNotSucceeded';
    this.status = status;
    this.failure = failure;
  }
}

export interface DurableExecutionHarness extends DurableHarness {
  readonly source: InMemoryFifoQueue;
  readonly dlq: InMemoryFifoQueue;
  readonly driver: FakeSqsEsmDriver;
  readonly log: RecordingDurableLogSink;
  /** Every execution the mapping started, in order. */
  readonly executions: TestResult<DurableStepResult>[];
  /** Runs one execution of the handler over `payload`, outside the mapping. */
  readonly execute: (payload: unknown) => Promise<TestResult<DurableStepResult>>;
}

export interface DurableExecutionOptions extends DurableHarnessOptions {
  /** Replaces the composed caller the handler resolves (a throwing factory, a faulting registry). */
  readonly caller?: (composed: DurableRefundCaller) => () => DurableRefundCaller;
}

/** The Durable variant's queue, mapping and durable handler over a fresh offline caller. */
export function durableExecutionHarness(options: DurableExecutionOptions = {}): DurableExecutionHarness {
  const base = durableHarness(options);
  const log = new RecordingDurableLogSink();
  const resolveCaller = options.caller?.(base.caller) ?? ((): DurableRefundCaller => base.caller);
  const handler = createDurableRefundHandler({ caller: resolveCaller, log }, TEST_RETRY);
  const executions: TestResult<DurableStepResult>[] = [];
  const execute = async (payload: unknown): Promise<TestResult<DurableStepResult>> => {
    const runner = new LocalDurableTestRunner<DurableStepResult>({ handlerFunction: handler });
    const result = await runner.run({ payload });
    executions.push(result);
    return result;
  };
  const queueIds = new SequentialUuidSource('99999999');
  const queueOptions = { clock: base.time, ids: queueIds, visibilityTimeoutMs: DURABLE_VISIBILITY_TIMEOUT_MS };
  const dlq = new InMemoryFifoQueue(queueOptions);
  const source = new InMemoryFifoQueue({ ...queueOptions, redrive: { maxReceiveCount: 2, deadLetterQueue: dlq } });
  const driver = new FakeSqsEsmDriver({
    queue: source,
    event_source_arn: DURABLE_SOURCE_ARN,
    invoke: async (event): Promise<void> => {
      const result = await execute(event);
      if (result.getStatus() !== 'SUCCEEDED') {
        throw new DurableExecutionNotSucceeded(result.getStatus(), result.getError());
      }
    },
  });
  return { ...base, source, dlq, driver, log, executions, execute };
}

/** Publishes a body as the runner does; returns the SQS message id. */
export function publishDurable(harness: DurableExecutionHarness, body: string = messageBody()): string {
  return harness.source.send({ body, message_group_id: TRIAL_ID, message_deduplication_id: TRIAL_ID }).message_id;
}

/** Runs `pending` to completion, advancing virtual time between short real sleeps. */
export async function pump<T>(harness: DurableHarness, pending: Promise<T>): Promise<T> {
  const progress = { done: false };
  const tracked = pending.finally(() => {
    progress.done = true;
  });
  tracked.catch(() => undefined);
  const deadline = Date.now() + PUMP_LIMIT_MS;
  while (!progress.done && Date.now() < deadline) {
    await sleep(PUMP_SLEEP_MS);
    await harness.time.advanceUntilIdle();
  }
  return tracked;
}

/** One poll of the mapping: one durable execution, pumped to its end. */
export function pollDurable(harness: DurableExecutionHarness): Promise<PollResult> {
  return pump(harness, harness.driver.pollOnce());
}

/** Lets the visibility timeout of an in-flight message expire. */
export async function waitOutDurableVisibility(harness: DurableExecutionHarness): Promise<void> {
  await harness.time.advanceBy(DURABLE_VISIBILITY_TIMEOUT_MS);
}

/** Sets up the runner's process-global environment with real time (RK-09). */
export async function setUpDurableRunner(): Promise<void> {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: false });
}

/** Tears the runner's environment down. */
export async function tearDownDurableRunner(): Promise<void> {
  await LocalDurableTestRunner.teardownTestEnvironment();
}

/** The names and final attempts of an execution's step operations. */
export function stepsOf(
  result: TestResult<DurableStepResult>,
): readonly (readonly [string | undefined, number | undefined])[] {
  return result
    .getOperations()
    .filter((operation) => operation.getType() === 'STEP')
    .map((operation) => [operation.getName(), operation.getStepDetails()?.attempt] as const);
}

/**
 * The step failures the SDK checkpointed in an execution's history, in order: step name, the
 * thrown error's type, and the delay before the next attempt (absent when the strategy stopped).
 * This is what the retry strategy decided, read from the SDK rather than from the strategy.
 * (`RetryDetails.CurrentAttempt` is not read: the local emulator reports 1 on every attempt,
 * durable-functions research §7.)
 *
 * @example
 * stepFailuresOf(execution); // [['refund-attempt', 'StepAttemptFailed', 1]]
 */
export function stepFailuresOf(
  result: TestResult<DurableStepResult>,
): readonly (readonly [string | undefined, string | undefined, number | undefined])[] {
  return result
    .getHistoryEvents()
    .filter((event) => event.EventType === 'StepFailed')
    .map(
      (event) =>
        [
          event.Name,
          event.StepFailedDetails?.Error?.Payload?.ErrorType,
          event.StepFailedDetails?.RetryDetails?.NextAttemptDelaySeconds,
        ] as const,
    );
}
