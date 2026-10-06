// An event that is no single SQS delivery, through the real durable SDK (design §9.5, A-05): the
// handler refuses it before the step, so no step attempt runs and nothing is journaled; the
// execution FAILS with the DurableCallerFault, and the handler logs exactly one
// `durable_caller_fault` line naming DELIVERY_INVALID and the bounded offending value. One test
// per file (RK-09).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  durableExecutionHarness,
  pump,
  setUpDurableRunner,
  stepsOf,
  tearDownDurableRunner,
} from '../support/durable-execution-harness.ts';

before(setUpDurableRunner);
after(tearDownDurableRunner);

describe('the Durable handler on an invalid delivery', () => {
  it('fails the execution before any step attempt and logs DELIVERY_INVALID', async () => {
    const harness = durableExecutionHarness();
    const execution = await pump(harness, harness.execute({ Records: [] }));

    assert.equal(execution.getStatus(), 'FAILED');
    assert.equal(execution.getError().errorType, 'DurableCallerFault');
    assert.match(
      String(execution.getError().errorMessage),
      /^DELIVERY_INVALID: SQS event Records array \[\]; expected/u,
    );
    assert.deepEqual(stepsOf(execution), []);
    assert.equal(execution.getInvocations().length, 1);
    assert.deepEqual(harness.store.itemsIn('caller_journal'), []);
    const [line, ...rest] = harness.log.lines();
    assert.deepEqual(rest, []);
    assert.ok(line?.event === 'durable_caller_fault', JSON.stringify(line));
    assert.equal(line.code, 'DELIVERY_INVALID');
    assert.match(line.lambda_request_id, /^[0-9a-f-]{36}$/u);
    assert.match(
      line.detail,
      /^DELIVERY_INVALID: SQS event Records array \[\]; expected an array of exactly one record/u,
    );
  });
});
