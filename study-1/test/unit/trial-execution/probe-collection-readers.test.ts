// The probe has no queue and no Durable caller (design §7: `probe/` has no `queues/`), so the DLQ
// and Durable readers its collection is built with must fail closed with a reason, never read
// another unit's resources. And the diagnostic text the executors log for refused or unfrozen
// units names every reason's code and detail.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PROBE_COLLECTION_READERS } from '../../../src/trial-execution/probe-workload-executor.ts';
import { formatUtcMillis } from '../../../src/record-contract/timestamps.ts';
import { describeReasons } from '../../../src/trial-execution/trial-setup.ts';

const ARN = 'arn:aws:lambda:us-east-1:123456789012:function:caller';

describe('probe collection readers', () => {
  it('fail every DLQ receive closed', async () => {
    assert.deepEqual(await PROBE_COLLECTION_READERS.dlq.receiveBatch('https://sqs.example/q'), {
      ok: false,
      error: { code: 'PROBE_HAS_NO_QUEUE' },
    });
  });

  it('fail every Durable read closed', async () => {
    const closed = { ok: false, error: { code: 'PROBE_HAS_NO_DURABLE_CALLER' } };
    const { durable } = PROBE_COLLECTION_READERS;
    const request = { function_arn: ARN, qualifier: '1', started_after: formatUtcMillis(new Date(0)) };
    assert.deepEqual(await durable.listPage(request), closed);
    assert.deepEqual(await durable.getExecution(ARN), closed);
    assert.deepEqual(await durable.historyPage(ARN), closed);
  });
});

describe('describeReasons', () => {
  it('joins each reason as CODE: detail', () => {
    const subject = 'BR-RUA-027';
    assert.equal(
      describeReasons([
        { code: 'A', subject, detail: 'first' },
        { code: 'B', subject, detail: 'second' },
      ]),
      'A: first; B: second',
    );
    assert.equal(describeReasons([]), '');
  });
});
