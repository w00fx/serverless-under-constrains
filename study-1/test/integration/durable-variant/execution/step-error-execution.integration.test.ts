// Step attempts that throw what the caller never raises, through the real durable SDK: a thrown
// value that is not an Error, then a TypeError, both from the trial-registry read. Each is logged
// as one `durable_step_attempt_error` line with its step attempt (a non-Error is described, never
// serialized), the retry strategy retries the first, and the exhausted step fails the execution
// with the SDK's StepError, logged once as `durable_execution_failed`. Nothing is journaled and
// no provider is called. One test per file (RK-09).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { InterleavingItemStore } from '../../../support/cleanup/interleaving-item-store.ts';
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

describe('the Durable handler on unexpected step errors', () => {
  it('logs each failed step attempt with its number, then the failed execution', async () => {
    const harness = durableExecutionHarness({
      wrapStore: (store) => {
        const throwing = new InterleavingItemStore(store);
        throwing.afterRead(1, () => {
          const notAnError: unknown = { code: 'opaque', secret: 'x'.repeat(10_000) };
          throw notAnError;
        });
        throwing.afterRead(2, () => {
          throw new TypeError('registry item decoder crashed');
        });
        return throwing;
      },
    });
    publishDurable(harness);

    assert.equal((await pollDurable(harness)).kind, 'failed');
    const [execution] = harness.executions;
    assert.equal(execution?.getStatus(), 'FAILED');
    assert.deepEqual(
      stepsOf(execution).map(([, attempt]) => attempt),
      [2],
    );
    assert.deepEqual(harness.store.itemsIn('caller_journal'), []);
    assert.equal(harness.invoker.invocations().length, 0);
    const lines = harness.log.lines();
    assert.deepEqual(
      lines.map((line) => [
        line.event,
        'step_attempt' in line ? line.step_attempt : undefined,
        'error_name' in line ? line.error_name : undefined,
        'detail' in line ? line.detail : undefined,
      ]),
      [
        ['durable_step_attempt_error', 1, 'NonErrorThrown', 'a thrown value that is not an Error instance'],
        ['durable_step_attempt_error', 2, 'TypeError', 'registry item decoder crashed'],
        // The SDK's StepError carries the last step attempt's error message.
        ['durable_execution_failed', undefined, 'StepError', 'registry item decoder crashed'],
      ],
    );
    assert.ok(
      lines.every((line) => JSON.stringify(line).length < 2_000),
      'every line bounded',
    );
  });
});
