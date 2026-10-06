// Conformance of FakeDlqMessages to the DlqMessagePort contract: each requested id is deleted,
// already absent or failed, exactly once per request, and nothing outside the request is touched.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeDlqMessages } from '../../../support/cleanup/fake-dlq-messages.ts';
import { RecordingMutationLog } from '../../../support/kernel/recording-mutation-log.ts';

describe('FakeDlqMessages conformance', () => {
  it('deletes requested messages only, and reports absent and failed ones', async () => {
    const log = new RecordingMutationLog();
    const dlq = new FakeDlqMessages(log);
    dlq.add('a', 'b', 'c');
    dlq.failDelete('b');
    const report = await dlq.deleteCaptured(['a', 'b', 'z']);
    assert.deepEqual(report.deleted, ['a']);
    assert.deepEqual(report.absent, ['z']);
    assert.deepEqual(
      report.failed.map((failure) => failure.message_id),
      ['b'],
    );
    assert.deepEqual(dlq.remaining(), ['b', 'c']);
    assert.deepEqual(dlq.requested(), ['a', 'b', 'z']);
    assert.equal(log.entries().length, 3);
    assert.deepEqual(await dlq.deleteCaptured(['a']), { deleted: [], absent: ['a'], failed: [] });
  });
});
