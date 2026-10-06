// A message the registration refuses, through the real durable SDK (BR-RUA-036, AC-RUA-019): the
// step journals the rejection, finishes the request MESSAGE_REJECTED and completes, so the
// execution SUCCEEDS with that result, the mapping deletes the message, no provider is called and
// nothing is logged. One test per file (RK-09).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  OTHER_RUN_ID,
  messageBody,
  runMessageObject,
} from '../../../unit/trial-message/support/trial-message-fixtures.ts';
import {
  durableExecutionHarness,
  pollDurable,
  publishDurable,
  setUpDurableRunner,
  tearDownDurableRunner,
} from '../support/durable-execution-harness.ts';
import { assertEventsConform, recordTypes, requestStates } from '../support/durable-harness.ts';

before(setUpDurableRunner);
after(tearDownDurableRunner);

describe('the Durable handler on a rejected message', () => {
  it('succeeds with MESSAGE_REJECTED in one step attempt and deletes the message', async () => {
    const harness = durableExecutionHarness();
    const messageId = publishDurable(harness, messageBody(runMessageObject({ run_id: OTHER_RUN_ID })));

    assert.deepEqual(await pollDurable(harness), { kind: 'completed', message_id: messageId, receive_count: 1 });
    const [execution] = harness.executions;
    assert.equal(execution?.getStatus(), 'SUCCEEDED');
    assert.deepEqual(execution.getResult(), { terminal_reason: 'MESSAGE_REJECTED' });
    assert.equal(execution.getInvocations().length, 1);
    assert.equal(harness.invoker.invocations().length, 0);
    assert.deepEqual(recordTypes(harness), [
      'caller_invocation_started',
      'trial_message_rejected',
      'request_state_recorded',
    ]);
    assert.deepEqual(
      requestStates(harness).map((state) => [state.processing_state, state.processing_terminal_reason]),
      [['FINISHED', 'MESSAGE_REJECTED']],
    );
    assert.deepEqual(harness.source.messages(), []);
    assert.deepEqual(harness.log.lines(), []);
    assertEventsConform(harness);
  });
});
