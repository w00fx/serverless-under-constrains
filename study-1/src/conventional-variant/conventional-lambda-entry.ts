// The Lambda entry of the conventional caller without its AWS wiring (design §5.1: a handler shell
// holds only wiring). One SQS event goes through consumeSqsEvent; when the delivery does not
// complete, one JSON line is written through the injected sink and the error is rethrown, never
// swallowed, so the event source mapping keeps the message and SQS delivers it again after the
// visibility timeout (BR-RUA-020).
//
// The line of an unexpected error is bounded and total over any thrown value (Owner amendment
// A-05): a provider-client RangeError or an environment error can carry any text, and a log line
// must never grow with it (WP-20 review).

import { boundedText } from '../record-contract/json-value.ts';
import type { JsonValue } from '../record-contract/primitives.ts';
import type { ConventionalRefundConsumer } from './conventional-consumer.ts';
import type { ConventionalFaultLog, DeliveryFailureLog } from './conventional-fault.ts';
import { ConventionalCallerFault, DeliveryFailurePropagated } from './conventional-fault.ts';
import { consumeSqsEvent } from './sqs-event-consumption.ts';

/** The JSON log line of an error the caller does not raise itself (an unmapped throw). */
export interface ConventionalErrorLog {
  readonly level: 'error';
  readonly event: 'conventional_caller_error';
  readonly lambda_request_id: string;
  readonly error_name: string;
  readonly detail: string;
}

export type ConventionalLogLine = ConventionalFaultLog | DeliveryFailureLog | ConventionalErrorLog;

/** Where the entry writes its structured log lines (stderr in production). */
export interface ConventionalLogSink {
  write(line: ConventionalLogLine): void;
}

export interface ConventionalEntryDeps {
  /** The consumer; resolved on first use, so a cold start creates no client early (RK-01). */
  readonly consumer: () => ConventionalRefundConsumer;
  readonly log: ConventionalLogSink;
}

/** The Lambda handler signature of the conventional caller. */
export type ConventionalLambdaEntry = (event: JsonValue, context: { readonly awsRequestId: string }) => Promise<void>;

/**
 * Builds the Lambda handler of the conventional caller: it resolves when the delivery completed
 * and rejects, after one log line, when it did not.
 *
 * @example
 * export const handler = createConventionalLambdaEntry({ consumer: consumerInstance, log: stderrSink });
 */
export function createConventionalLambdaEntry(deps: ConventionalEntryDeps): ConventionalLambdaEntry {
  return async (event, context) => {
    try {
      await consumeSqsEvent(deps.consumer(), event, context.awsRequestId);
    } catch (error: unknown) {
      deps.log.write(conventionalLogLine(error, context.awsRequestId));
      throw error;
    }
  };
}

/**
 * The log line of a delivery that did not complete: the caller's own line for a fault or a
 * propagated failure, otherwise a bounded description of the thrown value.
 *
 * @example
 * conventionalLogLine(new RangeError('bad qualifier'), 'req-1');
 * // { level: 'error', event: 'conventional_caller_error', lambda_request_id: 'req-1', error_name: 'RangeError', ... }
 */
export function conventionalLogLine(error: unknown, lambdaRequestId: string): ConventionalLogLine {
  if (error instanceof ConventionalCallerFault || error instanceof DeliveryFailurePropagated) {
    return error.toLog();
  }
  const thrown =
    error instanceof Error
      ? { error_name: boundedText(error.name), detail: boundedText(error.message) }
      : { error_name: 'NonErrorThrown', detail: 'a thrown value that is not an Error instance' };
  return { level: 'error', event: 'conventional_caller_error', lambda_request_id: lambdaRequestId, ...thrown };
}
