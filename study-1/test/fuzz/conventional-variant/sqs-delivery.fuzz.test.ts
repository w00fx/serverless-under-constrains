// Property-based tests of the SQS event guard (testing rule 6): the Lambda event is the caller's
// first untrusted input. The guard accepts exactly the events with one record whose messageId is
// 1 to 128 characters, whose body is a string and whose ApproximateReceiveCount is a positive
// decimal integer string, reading only own properties, and it is total over arbitrary JSON,
// values nested far deeper than the call stack and non-finite numbers (Owner amendment A-05).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { MESSAGE_ID_LIMIT, parseSqsDelivery } from '../../../src/conventional-variant/sqs-delivery.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { deepTowerArbitrary } from '../../support/kernel/deep-json.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const hostileValue: fc.Arbitrary<JsonValue> = fc.oneof(
  { arbitrary: fc.jsonValue({ maxDepth: 3 }) as fc.Arbitrary<JsonValue>, weight: 8 },
  { arbitrary: deepTowerArbitrary(), weight: 1 },
  { arbitrary: fc.constantFrom<JsonValue>(Number.POSITIVE_INFINITY, Number.NaN, -0, 1e21), weight: 1 },
);

const receiveCountText: fc.Arbitrary<string> = fc.oneof(
  fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }).map(String),
  fc.constantFrom('0', '01', '-1', '1.0', '1e3', ' 1', '1 ', '', 'Infinity', '9'.repeat(16), '１'),
  fc.string({ maxLength: 4 }),
);

const recordArbitrary = fc.record({
  messageId: fc.oneof(fc.string({ minLength: 0, maxLength: MESSAGE_ID_LIMIT + 2 }), hostileValue),
  body: fc.oneof(fc.string(), hostileValue),
  count: fc.oneof(receiveCountText, hostileValue),
  inheritsRecords: fc.boolean(),
});

function expectedCount(count: JsonValue): number | undefined {
  return typeof count === 'string' && /^[1-9][0-9]{0,14}$/u.test(count) ? Number(count) : undefined;
}

describe('parseSqsDelivery properties', () => {
  it('accepts exactly the well-formed single-record events, with their exact fields', () => {
    fc.assert(
      fc.property(recordArbitrary, ({ messageId, body, count, inheritsRecords }) => {
        const record: JsonObject = { messageId, body, attributes: { ApproximateReceiveCount: count } };
        const event: JsonObject = inheritsRecords
          ? (Object.create({ Records: [record] }) as JsonObject)
          : { Records: [record] };
        const parsed = parseSqsDelivery(event);
        const receiveCount = expectedCount(count);
        const wellFormed =
          !inheritsRecords &&
          typeof messageId === 'string' &&
          messageId.length >= 1 &&
          messageId.length <= MESSAGE_ID_LIMIT &&
          typeof body === 'string' &&
          receiveCount !== undefined;
        assert.equal(parsed.ok, wellFormed, parsed.ok ? 'accepted' : parsed.error.slice(0, 300));
        if (parsed.ok) {
          assert.deepEqual(parsed.value, { message_id: messageId, approximate_receive_count: receiveCount, body });
          assert.ok(Number.isSafeInteger(parsed.value.approximate_receive_count));
        }
      }),
      fuzzParameters(),
    );
  });

  it('judges any value without throwing, with a bounded message naming the expected shape', () => {
    const eventArbitrary = fc.oneof(
      hostileValue,
      hostileValue.map((records) => ({ Records: records })),
      fc.array(hostileValue, { maxLength: 3 }).map((records) => ({ Records: records })),
      hostileValue.map((attributes) => ({ Records: [{ messageId: 'm', body: '', attributes }] })),
    );
    fc.assert(
      fc.property(eventArbitrary, (event) => {
        const parsed = parseSqsDelivery(event);
        if (!parsed.ok) {
          assert.ok(parsed.error.length < 2_000, parsed.error.slice(0, 300));
          assert.match(parsed.error, /; expected /u);
        }
      }),
      fuzzParameters(),
    );
  });
});
