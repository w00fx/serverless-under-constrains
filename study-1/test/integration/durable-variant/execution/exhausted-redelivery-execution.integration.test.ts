// Inner exhaustion, source redelivery and the DLQ through the real durable SDK (BR-RUA-020,
// BR-RUA-024; AC-RUA-045 and AC-RUA-053 feed). The first receive's execution exhausts both step
// attempts: it FAILS with the SDK's StepError, the request stays RUNNING, and the mapping leaves
// the message to SQS. After the 360 s visibility timeout the second receive starts a NEW
// execution (another ARN), which exhausts too and finishes the request RETRIES_EXHAUSTED; the
// redrive then moves the message to the DLQ. Four provider attempts in all. One test per file
// (RK-09).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { DURABLE_REFUND_STEP_NAME } from '../../../../src/durable-variant/durable-refund-handler.ts';
import { transportError } from '../../../support/provider-client/provider-client-fixtures.ts';
import { REFUND_REQUEST_ID } from '../../../unit/trial-message/support/trial-message-fixtures.ts';
import {
  DurableExecutionNotSucceeded,
  durableExecutionHarness,
  pollDurable,
  publishDurable,
  setUpDurableRunner,
  stepFailuresOf,
  stepsOf,
  tearDownDurableRunner,
  waitOutDurableVisibility,
} from '../support/durable-execution-harness.ts';
import { TENTH_SECOND_NS, assertEventsConform, eventsOfType, requestStates } from '../support/durable-harness.ts';

before(setUpDurableRunner);
after(tearDownDurableRunner);

describe('the Durable handler on an exhausted execution', () => {
  it('fails the execution, keeps RUNNING until the last receive, then RETRIES_EXHAUSTED and the DLQ', async () => {
    const harness = durableExecutionHarness();
    for (let answer = 0; answer < 4; answer += 1) {
      harness.invoker.resolveAfter(TENTH_SECOND_NS, () => transportError('ServiceException', 'Service failure', 500));
    }
    const messageId = publishDurable(harness);

    const first = await pollDurable(harness);
    assert.ok(first.kind === 'failed', first.kind);
    assert.ok(first.error instanceof DurableExecutionNotSucceeded, String(first.error));
    assert.equal(first.error.status, 'FAILED');
    assert.equal(first.error.failure?.errorType, 'StepError');
    assert.deepEqual(
      requestStates(harness).map((state) => [state.processing_state, state.processing_terminal_reason]),
      [
        ['RUNNING', undefined],
        ['RUNNING', undefined],
      ],
    );
    assert.deepEqual(await pollDurable(harness), { kind: 'empty' }, 'invisible until the timeout expires');
    await waitOutDurableVisibility(harness);
    const second = await pollDurable(harness);
    assert.equal(second.kind === 'failed' ? second.receive_count : 0, 2);
    await waitOutDurableVisibility(harness);
    assert.deepEqual(await pollDurable(harness), { kind: 'empty' });

    assert.equal(harness.executions.length, 2);
    for (const execution of harness.executions) {
      assert.equal(execution.getStatus(), 'FAILED');
      assert.equal(execution.getInvocations().length, 2);
      assert.deepEqual(stepsOf(execution), [[DURABLE_REFUND_STEP_NAME, 2]]);
      // One retry after the fixed delay, then the strategy stops: no next attempt is scheduled.
      assert.deepEqual(stepFailuresOf(execution), [
        [DURABLE_REFUND_STEP_NAME, 'StepAttemptFailed', 1],
        [DURABLE_REFUND_STEP_NAME, 'StepAttemptFailed', undefined],
      ]);
    }
    assert.equal(harness.invoker.invocations().length, 4);
    assert.deepEqual(
      requestStates(harness).map((state) => [state.version, state.processing_state, state.processing_terminal_reason]),
      [
        [1, 'RUNNING', undefined],
        [2, 'RUNNING', undefined],
        [3, 'RUNNING', undefined],
        [4, 'FINISHED', 'RETRIES_EXHAUSTED'],
      ],
    );
    const exhausted = eventsOfType(harness, 'inner_execution_exhausted');
    assert.deepEqual(
      exhausted.map((event) => [event.refund_request_id, event.step_attempts, event.approximate_receive_count]),
      [
        [REFUND_REQUEST_ID, 2, 1],
        [REFUND_REQUEST_ID, 2, 2],
      ],
    );
    assert.notEqual(exhausted[0]?.durable_execution_arn, exhausted[1]?.durable_execution_arn, 'a new execution');
    assert.deepEqual(
      harness.dlq.messages().map((message) => [message.message_id, message.receive_count]),
      [[messageId, 2]],
    );
    assert.deepEqual(harness.source.messages(), []);
    assert.deepEqual(harness.log.events(), [
      'durable_step_attempt_failed',
      'durable_step_attempt_failed',
      'durable_execution_failed',
      'durable_step_attempt_failed',
      'durable_step_attempt_failed',
      'durable_execution_failed',
    ]);
    const failedLine = harness.log.lines()[2];
    assert.deepEqual(
      failedLine?.event === 'durable_execution_failed' ? [failedLine.error_name, failedLine.durable_execution_arn] : [],
      ['StepError', exhausted[0]?.durable_execution_arn],
    );
    assertEventsConform(harness);
  });
});
