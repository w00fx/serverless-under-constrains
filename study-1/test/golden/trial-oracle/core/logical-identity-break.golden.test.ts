// AC-RUA-039 golden (BR-RUA-003): a retry attempt that carries another refund_request_id fails
// BR-RUA-003, and the verdict is fail.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { coreMismatches } from './support/oracle-golden.ts';

describe('AC-RUA-039 a retry breaks the logical identity', () => {
  it('second-attempt-other-refund-request-id', async () => {
    assert.deepEqual(await coreMismatches('second-attempt-other-refund-request-id'), []);
  });
});
