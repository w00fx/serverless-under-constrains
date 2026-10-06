// The conventional Lambda entry under the fake event source mapping (BR-RUA-020; structured
// logging): a completed delivery writes no line and the mapping deletes the message; every
// delivery that does not complete writes exactly one JSON line and rethrows the very error, so
// the message returns after the visibility timeout. The consumer is resolved on each invocation,
// never at construction (RK-01).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createConventionalLambdaEntry } from '../../../src/conventional-variant/conventional-lambda-entry.ts';
import type { ConventionalRefundConsumer } from '../../../src/conventional-variant/conventional-consumer.ts';
import { ConventionalCallerFault } from '../../../src/conventional-variant/conventional-fault.ts';
import { QUOTED_JSON_LIMIT } from '../../../src/record-contract/json-value.ts';
import { succeededResponder } from '../../support/provider-client/provider-client-fixtures.ts';
import { conventionalHarness, poll, publish, settle, waitOutVisibility } from './support/conventional-harness.ts';
import { RecordingConventionalLogSink } from './support/recording-conventional-log-sink.ts';

const TENTH_SECOND_NS = 100_000_000n;

describe('createConventionalLambdaEntry', () => {
  it('writes no line for a completed delivery', async () => {
    const harness = conventionalHarness();
    harness.invoker.resolveAfter(TENTH_SECOND_NS, succeededResponder);
    const messageId = publish(harness);
    assert.deepEqual(await poll(harness), { kind: 'completed', message_id: messageId, receive_count: 1 });
    assert.deepEqual(harness.log.lines(), []);
  });

  it('logs a propagated failure as a warning naming the message and its receive, once per receive', async () => {
    const harness = conventionalHarness();
    harness.invoker.hang();
    harness.invoker.hang();
    const messageId = publish(harness);
    const first = await poll(harness);
    await waitOutVisibility(harness);
    const second = await poll(harness);
    assert.deepEqual([first.kind, second.kind], ['failed', 'failed']);
    assert.deepEqual(harness.log.lines(), [
      {
        level: 'warn',
        event: 'conventional_delivery_failed',
        lambda_request_id: 'lambda-request-0001',
        message_id: messageId,
        approximate_receive_count: 1,
      },
      {
        level: 'warn',
        event: 'conventional_delivery_failed',
        lambda_request_id: 'lambda-request-0002',
        message_id: messageId,
        approximate_receive_count: 2,
      },
    ]);
  });

  it('logs a fault with its code under the invocation request id, and rethrows the fault itself', async () => {
    const harness = conventionalHarness({ registration: null });
    publish(harness);
    const result = await poll(harness);
    assert.equal(result.kind, 'failed');
    const { error } = result;
    assert.ok(error instanceof ConventionalCallerFault, String(error));
    assert.deepEqual(harness.log.lines(), [error.toLog()]);
    assert.deepEqual(harness.log.lines()[0], {
      level: 'error',
      event: 'conventional_caller_fault',
      code: 'NO_ACTIVE_TRIAL',
      lambda_request_id: 'lambda-request-0001',
      detail: error.message,
    });
  });

  it('logs an event that is no single SQS delivery as DELIVERY_INVALID', async () => {
    const harness = conventionalHarness();
    const log = new RecordingConventionalLogSink();
    const entry = createConventionalLambdaEntry({ consumer: () => harness.consumer, log });
    await assert.rejects(
      settle(harness, entry({ Records: [] }, { awsRequestId: 'lambda-request-x' })),
      (error: unknown) => error instanceof ConventionalCallerFault && error.code === 'DELIVERY_INVALID',
    );
    assert.deepEqual(
      log.lines().map((line) => ('code' in line ? [line.event, line.code, line.lambda_request_id] : line.event)),
      [['conventional_caller_fault', 'DELIVERY_INVALID', 'lambda-request-x']],
    );
  });

  it('logs an unmapped error by its name and message, and rethrows it', async () => {
    const harness = conventionalHarness({ providerQualifier: '$LATEST' });
    publish(harness);
    const result = await poll(harness);
    assert.ok(result.kind === 'failed' && result.error instanceof RangeError, JSON.stringify(result));
    assert.deepEqual(harness.log.lines(), [
      {
        level: 'error',
        event: 'conventional_caller_error',
        lambda_request_id: 'lambda-request-0001',
        error_name: 'RangeError',
        detail: result.error.message,
      },
    ]);
    assert.match(result.error.message, /provider_qualifier "\$LATEST"/u);
  });

  it('resolves the consumer per invocation, and logs a boundedly described failure to build it', async () => {
    const log = new RecordingConventionalLogSink();
    const cause = new Error(`environment ${'x'.repeat(100_000)}`);
    let resolutions = 0;
    const entry = createConventionalLambdaEntry({
      consumer: (): ConventionalRefundConsumer => {
        resolutions += 1;
        throw cause;
      },
      log,
    });
    assert.equal(resolutions, 0, 'nothing is resolved at construction');
    await assert.rejects(entry({ Records: [] }, { awsRequestId: 'lambda-request-y' }), (error: unknown) => {
      return error === cause;
    });
    assert.equal(resolutions, 1);
    assert.deepEqual(log.lines(), [
      {
        level: 'error',
        event: 'conventional_caller_error',
        lambda_request_id: 'lambda-request-y',
        error_name: 'Error',
        detail: `${cause.message.slice(0, QUOTED_JSON_LIMIT)}…[truncated]`,
      },
    ]);
  });
});
