// A caller that cannot be built, through the real durable SDK (RK-01: the caller is resolved
// lazily, outside the step): the factory's Error fails the execution before any step attempt,
// nothing is journaled, and the handler logs one `durable_execution_failed` line with the
// error's bounded name and message. One test per file (RK-09).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { DurableRefundCaller } from '../../../../src/durable-variant/durable-refund-caller.ts';
import {
  durableExecutionHarness,
  pollDurable,
  publishDurable,
  setUpDurableRunner,
  stepsOf,
  tearDownDurableRunner,
} from '../support/durable-execution-harness.ts';

before(setUpDurableRunner);
after(tearDownDurableRunner);

const ENVIRONMENT_ERROR = 'durable caller environment invalid: SUC_VARIANT_ID "conventional"; expected durable';

function unavailableCaller(): () => DurableRefundCaller {
  return () => {
    throw new Error(ENVIRONMENT_ERROR);
  };
}

describe('the Durable handler without a caller', () => {
  it('fails the execution outside the step and logs durable_execution_failed', async () => {
    const harness = durableExecutionHarness({ caller: unavailableCaller });
    publishDurable(harness);

    const result = await pollDurable(harness);
    assert.equal(result.kind, 'failed');
    const [execution] = harness.executions;
    assert.equal(execution?.getStatus(), 'FAILED');
    assert.deepEqual(stepsOf(execution), []);
    assert.deepEqual(harness.store.itemsIn('caller_journal'), []);
    assert.equal(harness.invoker.invocations().length, 0);
    const [line, ...rest] = harness.log.lines();
    assert.deepEqual(rest, []);
    assert.ok(line?.event === 'durable_execution_failed', JSON.stringify(line));
    assert.deepEqual(
      { name: line.error_name, detail: line.detail, level: line.level },
      { name: 'Error', detail: ENVIRONMENT_ERROR, level: 'error' },
    );
    assert.match(line.durable_execution_arn, /\S/u);
    assert.equal('step_attempt' in line, false);
  });
});
