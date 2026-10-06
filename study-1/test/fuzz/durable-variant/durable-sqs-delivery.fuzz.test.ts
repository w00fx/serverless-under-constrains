// Property-based tests of the Durable caller's SQS event guard (testing rule 6): the execution's
// input payload is the caller's first untrusted input. The guard accepts exactly the events with
// one record whose messageId is 1 to 128 characters, whose body is a string and whose
// ApproximateReceiveCount is a positive decimal integer string, reading only own properties, and
// it is total over arbitrary JSON, values nested far deeper than the call stack and non-finite
// numbers (Owner amendment A-05).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import {
  DURABLE_MESSAGE_ID_LIMIT,
  parseDurableSqsDelivery,
} from '../../../src/durable-variant/durable-sqs-delivery.ts';
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
  messageId: fc.oneof(fc.string({ minLength: 0, maxLength: DURABLE_MESSAGE_ID_LIMIT + 2 }), hostileValue),
  body: fc.oneof(fc.string(), hostileValue),
  count: fc.oneof(receiveCountText, hostileValue),
  inherited: fc.constantFrom('none', 'Records', 'messageId', 'attributes'),
  extraRecords: fc.integer({ min: 0, max: 2 }),
});

function expectedCount(count: JsonValue): number | undefined {
  return typeof count === 'string' && /^[1-9][0-9]{0,14}$/u.test(count) ? Number(count) : undefined;
}

/** Builds the event, moving the `inherited` member onto a prototype so only own reads see past it. */
function eventOf(record: JsonObject, inherited: string, extraRecords: number): JsonObject {
  const shown: JsonObject =
    inherited === 'messageId' || inherited === 'attributes'
      ? Object.assign(Object.create({ [inherited]: record[inherited] }) as JsonObject, {
          ...Object.fromEntries(Object.entries(record).filter(([name]) => name !== inherited)),
        })
      : record;
  const records = [shown, ...Array.from({ length: extraRecords }, () => record)];
  return inherited === 'Records' ? (Object.create({ Records: records }) as JsonObject) : { Records: records };
}

describe('parseDurableSqsDelivery properties', () => {
  it('accepts exactly the well-formed single-record events, with their exact fields', () => {
    fc.assert(
      fc.property(recordArbitrary, ({ messageId, body, count, inherited, extraRecords }) => {
        const record: JsonObject = { messageId, body, attributes: { ApproximateReceiveCount: count } };
        const parsed = parseDurableSqsDelivery(eventOf(record, inherited, extraRecords));
        const receiveCount = expectedCount(count);
        const wellFormed =
          inherited === 'none' &&
          extraRecords === 0 &&
          typeof messageId === 'string' &&
          messageId.length >= 1 &&
          messageId.length <= DURABLE_MESSAGE_ID_LIMIT &&
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
      hostileValue.map((record) => ({ Records: [record] })),
    );
    fc.assert(
      fc.property(eventArbitrary, (event) => {
        const parsed = parseDurableSqsDelivery(event);
        if (!parsed.ok) {
          assert.ok(parsed.error.length < 2_000, parsed.error.slice(0, 300));
          assert.match(parsed.error, /; expected /u);
        }
      }),
      fuzzParameters(),
    );
  });
});
