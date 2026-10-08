// The durable execution of the Durable variant (design §5.3, §9.4; BR-RUA-020, BR-RUA-053):
// `withDurableExecution` over one step, `refund-attempt`, which the explicit retry strategy runs
// at most twice with the OR-RUA-002 delay and no jitter, with the SDK's default at-least-once
// semantics per retry (D-11). Code outside the step runs again on every replay, so it only parses
// the delivery and resolves the caller; every journal write happens inside the step (design
// §5.3). An exhausted step rejects with the SDK's StepError and fails the execution, so the event
// source mapping leaves the message to SQS: a redelivery starts a new execution (no ESM
// idempotency, durable-functions research §4), and the last receive moves it to the DLQ.
//
// Each failed step attempt and each failed execution is logged as one JSON line through the
// injected sink (structured logging); the error is always rethrown, never swallowed.

import { StepSemantics, withDurableExecution } from '@aws/durable-execution-sdk-js';
import type { DurableLambdaHandler } from '@aws/durable-execution-sdk-js';

import { boundedText } from '../record-contract/json-value.ts';
import type { JsonValue } from '../record-contract/primitives.ts';
import type { DurableFaultLog, StepAttemptFailedLog } from './durable-fault.ts';
import { DurableCallerFault, StepAttemptFailed } from './durable-fault.ts';
import type { DurableInvocation, DurableRefundCaller, DurableStepResult } from './durable-refund-caller.ts';
import { createStepRetryStrategy } from './durable-retry.ts';
import type { DurableRetryConfig } from './durable-retry.ts';
import { parseDurableSqsDelivery } from './durable-sqs-delivery.ts';
import type { DurableDelivery } from './durable-sqs-delivery.ts';

/** The name of the execution's one step (its operations and history events carry it). */
export const DURABLE_REFUND_STEP_NAME = 'refund-attempt';

/** Where a step attempt or execution failed, without the step attempt when none ran. */
type ExecutionPlace = Omit<DurableInvocation, 'step_attempt'>;

/** A thrown value, described for a log line: bounded, and total over any thrown value. */
export interface ThrownDescription {
  readonly error_name: string;
  readonly detail: string;
}

/** The JSON log line of an execution that failed (an exhausted step, or a failure outside it). */
export interface DurableExecutionFailedLog extends ExecutionPlace, ThrownDescription {
  readonly level: 'error';
  readonly event: 'durable_execution_failed';
}

/** The JSON log line of a step attempt that failed with an error the caller does not raise. */
export interface DurableStepErrorLog extends DurableInvocation, ThrownDescription {
  readonly level: 'error';
  readonly event: 'durable_step_attempt_error';
}

export type DurableLogLine = DurableFaultLog | StepAttemptFailedLog | DurableExecutionFailedLog | DurableStepErrorLog;

/** Where the handler writes its structured log lines (stderr in production). */
export interface DurableLogSink {
  write(line: DurableLogLine): void;
}

export interface DurableHandlerDeps {
  /** The step attempt logic; resolved on first use, so a cold start creates no client early (RK-01). */
  readonly caller: () => DurableRefundCaller;
  readonly log: DurableLogSink;
}

/**
 * Builds the Lambda handler of the Durable caller. Throws a RangeError at construction for a
 * retry delay that is not a positive safe integer.
 *
 * @example
 * export const handler = createDurableRefundHandler({ caller: () => composeDurableCaller(runtime), log },
 *   DEPLOYED_DURABLE_RETRY);
 */
export function createDurableRefundHandler(deps: DurableHandlerDeps, cfg: DurableRetryConfig): DurableLambdaHandler {
  const retryStrategy = createStepRetryStrategy(cfg);
  return withDurableExecution<JsonValue, DurableStepResult>(async (event, context) => {
    const place: ExecutionPlace = {
      lambda_request_id: context.lambdaContext.awsRequestId,
      durable_execution_arn: context.executionContext.durableExecutionArn,
    };
    try {
      const delivery = deliveryOf(event, place);
      const caller = deps.caller();
      return await context.step(
        DURABLE_REFUND_STEP_NAME,
        (step) => runLoggedStep(caller, delivery, { ...place, step_attempt: step.attempt }, deps.log),
        { retryStrategy, semantics: StepSemantics.AtLeastOncePerRetry },
      );
    } catch (error: unknown) {
      deps.log.write(
        error instanceof DurableCallerFault
          ? error.toLog()
          : { level: 'error', event: 'durable_execution_failed', ...place, ...describeThrown(error) },
      );
      throw error;
    }
  });
}

function deliveryOf(event: JsonValue, place: ExecutionPlace): DurableDelivery {
  const delivery = parseDurableSqsDelivery(event);
  if (!delivery.ok) {
    throw new DurableCallerFault('DELIVERY_INVALID', place.lambda_request_id, delivery.error);
  }
  return delivery.value;
}

async function runLoggedStep(
  caller: DurableRefundCaller,
  delivery: DurableDelivery,
  invocation: DurableInvocation,
  log: DurableLogSink,
): Promise<DurableStepResult> {
  try {
    return await caller.runStepAttempt(delivery, invocation);
  } catch (error: unknown) {
    log.write(stepFailureLog(invocation, error));
    throw error;
  }
}

function stepFailureLog(invocation: DurableInvocation, error: unknown): DurableLogLine {
  if (error instanceof StepAttemptFailed || error instanceof DurableCallerFault) {
    return error.toLog();
  }
  return { level: 'error', event: 'durable_step_attempt_error', ...invocation, ...describeThrown(error) };
}

function describeThrown(error: unknown): ThrownDescription {
  return error instanceof Error
    ? { error_name: boundedText(error.name), detail: boundedText(error.message) }
    : { error_name: 'NonErrorThrown', detail: 'a thrown value that is not an Error instance' };
}
