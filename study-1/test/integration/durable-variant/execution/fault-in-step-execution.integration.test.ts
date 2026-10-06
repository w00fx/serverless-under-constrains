// A caller fault inside the step, through the real durable SDK (BR-RUA-020): without an active
// durable trial each step attempt throws NO_ACTIVE_TRIAL, logged as one `durable_caller_fault`
// line per attempt; the retry strategy retries it once, and the exhausted step fails the
// execution, which the mapping leaves to SQS. Nothing is journaled and no provider is called. One
// test per file (RK-09).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  durableExecutionHarness,
  pollDurable,
  publishDurable,
  setUpDurableRunner,
  tearDownDurableRunner,
} from '../support/durable-execution-harness.ts';

before(setUpDurableRunner);
after(tearDownDurableRunner);

describe('the Durable handler on a caller fault inside the step', () => {
  it('logs the fault of each step attempt, then fails the execution', async () => {
    const harness = durableExecutionHarness({ registration: null });
    publishDurable(harness);

    const result = await pollDurable(harness);
    assert.equal(result.kind === 'failed' ? result.receive_count : 0, 1);
    assert.equal(harness.executions[0]?.getStatus(), 'FAILED');
    assert.deepEqual(
      harness.log.lines().map((line) => [line.event, 'code' in line ? line.code : undefined]),
      [
        ['durable_caller_fault', 'NO_ACTIVE_TRIAL'],
        ['durable_caller_fault', 'NO_ACTIVE_TRIAL'],
        ['durable_execution_failed', undefined],
      ],
    );
    assert.deepEqual(harness.store.itemsIn('caller_journal'), []);
    assert.equal(harness.invoker.invocations().length, 0);
    assert.equal(harness.source.messages().length, 1, 'the message stays in flight for a redelivery');
  });
});
