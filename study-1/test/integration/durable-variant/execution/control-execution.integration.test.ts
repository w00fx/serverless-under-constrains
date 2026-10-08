// A control trial through the real durable SDK (BR-RUA-020, design §9.4): one SQS delivery
// starts one durable execution whose single `refund-attempt` step succeeds on its first attempt;
// the execution SUCCEEDS with the step's result, the mapping deletes the message, and the handler
// logs nothing. One test per file: the runner's environment is process-global (RK-09).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { DURABLE_REFUND_STEP_NAME } from '../../../../src/durable-variant/durable-refund-handler.ts';
import { succeededResponder } from '../../../support/provider-client/provider-client-fixtures.ts';
import {
  durableExecutionHarness,
  pollDurable,
  publishDurable,
  setUpDurableRunner,
  stepsOf,
  tearDownDurableRunner,
} from '../support/durable-execution-harness.ts';
import { TENTH_SECOND_NS, assertEventsConform, eventsOfType, requestStates } from '../support/durable-harness.ts';

before(setUpDurableRunner);
after(tearDownDurableRunner);

describe('the Durable handler on a control delivery', () => {
  it('succeeds in one invocation and one step attempt, deletes the message and logs nothing', async () => {
    const harness = durableExecutionHarness();
    harness.invoker.resolveAfter(TENTH_SECOND_NS, succeededResponder);
    const messageId = publishDurable(harness);

    assert.deepEqual(await pollDurable(harness), { kind: 'completed', message_id: messageId, receive_count: 1 });
    const [execution] = harness.executions;
    assert.equal(execution?.getStatus(), 'SUCCEEDED');
    assert.deepEqual(execution.getResult(), { terminal_reason: 'SUCCEEDED' });
    assert.equal(execution.getInvocations().length, 1);
    assert.deepEqual(stepsOf(execution), [[DURABLE_REFUND_STEP_NAME, 1]]);

    const [started] = eventsOfType(harness, 'caller_invocation_started');
    assert.ok(started !== undefined && 'durable_execution_arn' in started);
    assert.match(started.durable_execution_arn, /\S/u);
    assert.equal(started.step_attempt, 1);
    assert.equal(started.message_id, messageId);
    // The local runner names each invocation's Lambda context itself (not the invocation record's id).
    assert.match(started.lambda_request_id, /^[0-9a-f-]{36}$/u);
    assert.deepEqual(
      requestStates(harness).map((state) => [state.processing_state, state.processing_terminal_reason]),
      [['FINISHED', 'SUCCEEDED']],
    );
    assert.deepEqual(harness.source.messages(), []);
    assert.deepEqual(harness.dlq.messages(), []);
    assert.deepEqual(harness.log.lines(), []);
    assertEventsConform(harness);
  });
});
