// The fixed transport settings (BR-RUA-011, BR-RUA-053; design §9.13 cases 1 and 3): pinned
// exactly, because a changed deadline, retry count or HTTP timeout silently changes what every
// variant measures.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PROVIDER_CLIENT_TIMING,
  PROVIDER_HTTP_HANDLER_OPTIONS,
  PROVIDER_LAMBDA_CLIENT_OPTIONS,
} from '../../../src/provider-client/transport-options.ts';

describe('transport options', () => {
  it('the deadline is exactly 3 s of monotonic time and the late-settlement grace exactly 2 s', () => {
    assert.deepEqual(PROVIDER_CLIENT_TIMING, { deadline_ns: 3_000_000_000n, late_settlement_grace_ns: 2_000_000_000n });
  });

  it('the deadline plus the grace leaves at least 5 s of the 10 s caller invocation timeout (OR-RUA-002)', () => {
    const invocationTimeoutNs = 10_000_000_000n;
    const { deadline_ns: deadline, late_settlement_grace_ns: grace } = PROVIDER_CLIENT_TIMING;
    assert.ok(invocationTimeoutNs - deadline - grace >= 5_000_000_000n);
  });

  it('the Lambda client makes one attempt in us-east-1', () => {
    assert.deepEqual(PROVIDER_LAMBDA_CLIENT_OPTIONS, { region: 'us-east-1', maxAttempts: 1 });
  });

  it('every HTTP timeout is disabled and the connection is kept alive', () => {
    assert.deepEqual(PROVIDER_HTTP_HANDLER_OPTIONS, {
      connectionTimeout: 0,
      requestTimeout: 0,
      socketTimeout: 0,
      throwOnRequestTimeout: false,
      keepAlive: true,
    });
  });
});
