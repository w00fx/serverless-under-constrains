// A timed-out first step attempt through the real durable SDK (BR-RUA-020, AC-RUA-003 feed): the
// step attempt fails, the retry strategy schedules the second after the delay, the execution
// suspends and the SDK re-invokes it; the second step attempt succeeds, so the one execution
// SUCCEEDS on the first receive with knowledge UNKNOWN kept. Each step attempt is its own Lambda
// invocation and its own `durable_caller` source instance, and the handler logs exactly the one
// failed step attempt (no spurious line for the suspension). One test per file (RK-09).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { DURABLE_REFUND_STEP_NAME } from '../../../../src/durable-variant/durable-refund-handler.ts';
import { succeededResponder } from '../../../support/provider-client/provider-client-fixtures.ts';
import {
  durableExecutionHarness,
  pollDurable,
  publishDurable,
  TEST_RETRY,
  setUpDurableRunner,
  stepFailuresOf,
  stepsOf,
  tearDownDurableRunner,
} from '../support/durable-execution-harness.ts';
import { TENTH_SECOND_NS, assertEventsConform, eventsOfType, requestStates } from '../support/durable-harness.ts';

before(setUpDurableRunner);
after(tearDownDurableRunner);

describe('the Durable handler on a step retry', () => {
  it('retries the step in a second invocation of the same execution and succeeds on the first receive', async () => {
    const harness = durableExecutionHarness();
    harness.invoker.hang();
    harness.invoker.resolveAfter(TENTH_SECOND_NS, succeededResponder);
    const messageId = publishDurable(harness);

    assert.deepEqual(await pollDurable(harness), { kind: 'completed', message_id: messageId, receive_count: 1 });
    assert.equal(harness.executions.length, 1);
    const [execution] = harness.executions;
    assert.equal(execution?.getStatus(), 'SUCCEEDED');
    assert.deepEqual(execution.getResult(), { terminal_reason: 'SUCCEEDED' });
    assert.equal(execution.getInvocations().length, 2);
    assert.deepEqual(stepsOf(execution), [[DURABLE_REFUND_STEP_NAME, 2]]);
    // The SDK checkpointed the one retry with the handler's fixed delay (OR-RUA-002, injected 1 s).
    assert.equal(TEST_RETRY.delay_seconds, 1);
    assert.deepEqual(stepFailuresOf(execution), [[DURABLE_REFUND_STEP_NAME, 'StepAttemptFailed', 1]]);

    const starts = eventsOfType(harness, 'caller_invocation_started').map((event) =>
      'durable_execution_arn' in event
        ? { arn: event.durable_execution_arn, step: event.step_attempt, receive: event.approximate_receive_count }
        : undefined,
    );
    const arn = starts[0]?.arn;
    assert.deepEqual(starts, [
      { arn, step: 1, receive: 1 },
      { arn, step: 2, receive: 1 },
    ]);
    const instances = new Set(eventsOfType(harness, 'caller_invocation_started').map((e) => e.source_instance_id));
    assert.equal(instances.size, 2, 'one source instance per step attempt');
    const attempts = eventsOfType(harness, 'attempt_registered').map((event) => event.attempt_id);
    assert.deepEqual(requestStates(harness), [
      {
        version: 1,
        processing_state: 'RUNNING',
        processing_terminal_reason: undefined,
        effect_knowledge: 'UNKNOWN',
        attempt_ids: [attempts[0]],
      },
      {
        version: 2,
        processing_state: 'FINISHED',
        processing_terminal_reason: 'SUCCEEDED',
        effect_knowledge: 'UNKNOWN',
        attempt_ids: attempts,
      },
    ]);
    const [firstStart] = eventsOfType(harness, 'caller_invocation_started');
    assert.deepEqual(harness.log.lines(), [
      {
        level: 'warn',
        event: 'durable_step_attempt_failed',
        lambda_request_id: firstStart?.lambda_request_id,
        durable_execution_arn: arn,
        step_attempt: 1,
        attempt_id: attempts[0],
        outcome_class: 'AMBIGUOUS',
      },
    ]);
    assert.deepEqual(harness.dlq.messages(), []);
    assertEventsConform(harness);
  });
});
