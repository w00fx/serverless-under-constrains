// parseProviderResponse over arbitrary payload bytes, JSON payloads and settlements: it never
// throws and bounds every detail, diagnostic and outcome event (WP-06 review rounds 1 and 2;
// testing rule 6). The example cases are in test/unit/provider-client/provider-response.test.ts;
// the properties live here so `npm run test:fuzz` and `fuzz:campaign` reach them (Owner
// amendment A-11).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { outcomeRecordBody, resolutionFromResponse } from '../../../src/provider-client/attempt-resolution.ts';
import {
  parseProviderResponse,
  RESPONSE_DIAGNOSTIC_MAX_CHARS,
} from '../../../src/provider-client/provider-response.ts';
import type { DecimalString, JsonValue } from '../../../src/record-contract/primitives.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import {
  FIRST_ATTEMPT_ID,
  FIRST_PROVIDER_REQUEST_ID,
  jsonBytes,
} from '../../support/provider-client/provider-client-fixtures.ts';
import {
  EXPECTED_RESPONSE as EXPECTED,
  failedParseOf as failureOf,
  respondWith as respond,
  SUCCEEDED_PAYLOAD,
} from '../../support/provider-client/provider-response-samples.ts';

describe('parseProviderResponse on hostile settlements', () => {
  // The longest detail repeats two bounded values (a transport error's name and message).
  const MAX_DETAIL_CHARS = 1024;
  // A diagnostic keeps at most RESPONSE_DIAGNOSTIC_MAX_CHARS characters plus the cut marker.
  const MAX_DIAGNOSTIC_CHARS = RESPONSE_DIAGNOSTIC_MAX_CHARS + '…[truncated from 9007199254740991 chars]'.length;
  // Far below the 400 KB item limit (aws-semantics.md), whatever the settlement carried.
  const MAX_OUTCOME_BODY_BYTES = 8 * 1024;
  const CORRELATION = {
    attempt_id: FIRST_ATTEMPT_ID,
    provider_request_id: FIRST_PROVIDER_REQUEST_ID,
    refund_request_id: 'ref-1',
  };

  it('never throws and bounds its detail over arbitrary payload bytes (property)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (payload) => {
        const failure = failureOf(respond({ payload }));
        assert.equal(failure.code, 'MALFORMED_RESPONSE');
        assert.ok(failure.detail.length <= MAX_DETAIL_CHARS, failure.detail);
      }),
      fuzzParameters(),
    );
  });

  it('never throws and bounds its detail over arbitrary JSON payloads, deep ones included (property)', () => {
    const encoder = new TextEncoder();
    const payload = fc.oneof(
      (fc.jsonValue({ depthSize: 'xlarge', maxDepth: 50 }) as fc.Arbitrary<JsonValue>).map(jsonBytes),
      fc
        .tuple(fc.constantFrom(...Object.keys(SUCCEEDED_PAYLOAD)), fc.jsonValue() as fc.Arbitrary<JsonValue>)
        .map(([name, value]) => jsonBytes({ ...SUCCEEDED_PAYLOAD, [name]: value })),
      fc
        .tuple(fc.nat({ max: 20_000 }), fc.constantFrom(['[', ']'], ['{"a":', '}']))
        .map(([depth, [open, close]]) => encoder.encode(`${open.repeat(depth)}1${close.repeat(depth)}`)),
    );
    fc.assert(
      fc.property(payload, (bytes) => {
        const parsed = parseProviderResponse(respond({ payload: bytes }), EXPECTED);
        assert.ok(['succeeded', 'rejected', 'failed'].includes(parsed.kind));
        assert.ok(parsed.kind !== 'failed' || parsed.failure.detail.length <= MAX_DETAIL_CHARS);
      }),
      fuzzParameters(),
    );
  });

  it('never throws and bounds its detail, diagnostics and outcome event over arbitrary settlements (property)', () => {
    const text = fc.oneof(fc.string(), fc.string({ unit: 'binary', minLength: 300, maxLength: 2_000 }));
    const settlement = fc.oneof(
      fc.record({
        kind: fc.constant('response' as const),
        status_code: fc.integer(),
        executed_version: fc.option(text, { nil: undefined }),
        function_error: fc.option(text, { nil: undefined }),
        payload: fc.uint8Array({ maxLength: 64 }),
      }),
      fc.record(
        {
          kind: fc.constant('transport_error' as const),
          error_name: text,
          message: text,
          http_status: fc.integer(),
        },
        { requiredKeys: ['kind', 'error_name', 'message'] },
      ),
    );
    const encoder = new TextEncoder();
    fc.assert(
      fc.property(settlement, (result) => {
        const parsed = parseProviderResponse(result, EXPECTED);
        assert.ok(parsed.kind !== 'failed' || parsed.failure.detail.length <= MAX_DETAIL_CHARS, parsed.kind);
        assert.ok((parsed.function_error?.length ?? 0) <= MAX_DIAGNOSTIC_CHARS);
        assert.ok((parsed.executed_version?.length ?? 0) <= MAX_DIAGNOSTIC_CHARS);
        const body = outcomeRecordBody(CORRELATION, resolutionFromResponse(parsed, '1' as DecimalString));
        assert.ok(encoder.encode(JSON.stringify(body)).length <= MAX_OUTCOME_BODY_BYTES);
      }),
      fuzzParameters(),
    );
  });
});
