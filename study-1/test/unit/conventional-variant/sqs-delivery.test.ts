// The Lambda SQS event of the conventional caller (design §9.5, BatchSize 1): exactly one record
// with a message id, a body and a positive receive count, parsed totally (Owner amendment A-05).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MESSAGE_ID_LIMIT, parseSqsDelivery } from '../../../src/conventional-variant/sqs-delivery.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { DEEP_NESTING, parsedTower } from '../../support/kernel/deep-json.ts';

function sqsRecord(overrides: JsonObject = {}): JsonObject {
  return {
    messageId: 'f5a3c0de-0000-4000-8000-000000000001',
    receiptHandle: 'handle-1',
    body: '{"record_type":"trial_message"}\n',
    attributes: { ApproximateReceiveCount: '1', MessageGroupId: 'g' },
    eventSource: 'aws:sqs',
    ...overrides,
  };
}

function refusal(event: JsonValue): string {
  const parsed = parseSqsDelivery(event);
  assert.equal(parsed.ok, false);
  return parsed.error;
}

describe('parseSqsDelivery', () => {
  it('reads the message id, body and receive count of the single record', () => {
    assert.deepEqual(parseSqsDelivery({ Records: [sqsRecord({ attributes: { ApproximateReceiveCount: '2' } })] }), {
      ok: true,
      value: {
        message_id: 'f5a3c0de-0000-4000-8000-000000000001',
        approximate_receive_count: 2,
        body: '{"record_type":"trial_message"}\n',
      },
    });
  });

  it(`accepts a message id of ${String(MESSAGE_ID_LIMIT)} characters and a 15-digit receive count`, () => {
    const parsed = parseSqsDelivery({
      Records: [
        sqsRecord({ messageId: 'm'.repeat(MESSAGE_ID_LIMIT), attributes: { ApproximateReceiveCount: '9'.repeat(15) } }),
      ],
    });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.approximate_receive_count, 999_999_999_999_999);
  });

  it('refuses an event that is not one record', () => {
    assert.equal(refusal({}), 'SQS event Records absent; expected an array of exactly one record (BatchSize 1)');
    assert.match(refusal({ Records: [] }), /^SQS event Records array \[\]; expected an array of exactly one record/);
    assert.match(refusal({ Records: [sqsRecord(), sqsRecord()] }), /expected an array of exactly one record/);
    assert.match(refusal([sqsRecord()]), /SQS event Records absent/);
    assert.equal(refusal({ Records: ['x'] }), 'SQS record string "x"; expected a JSON object');
  });

  it('refuses a record without a usable message id, body or receive count', () => {
    const cases: readonly (readonly [JsonObject, string])[] = [
      [sqsRecord({ messageId: '' }), 'SQS record messageId string ""; expected a string of 1 to 128 characters'],
      [sqsRecord({ messageId: 7 }), 'SQS record messageId number 7; expected a string of 1 to 128 characters'],
      [
        sqsRecord({ messageId: 'm'.repeat(MESSAGE_ID_LIMIT + 1) }),
        `SQS record messageId string "${'m'.repeat(129)}"; expected a string of 1 to 128 characters`,
      ],
      [sqsRecord({ body: null }), 'SQS record body null null; expected a string'],
      [
        sqsRecord({ attributes: null }),
        'SQS record attributes.ApproximateReceiveCount absent; expected a positive decimal integer string',
      ],
    ];
    for (const [record, expected] of cases) {
      assert.equal(refusal({ Records: [record] }), expected);
    }
    for (const count of ['0', '01', '-1', '1.5', 'one', '', '1'.repeat(16), 1]) {
      assert.match(
        refusal({ Records: [sqsRecord({ attributes: { ApproximateReceiveCount: count } })] }),
        /ApproximateReceiveCount .*; expected a positive decimal integer string$/,
      );
    }
  });

  it('never reads inherited members as event fields', () => {
    const text =
      '{"Records":[{"__proto__":{"messageId":"m","body":"b"},"attributes":{"ApproximateReceiveCount":"1"}}]}';
    assert.match(refusal(JSON.parse(text) as JsonValue), /^SQS record messageId absent/);
  });

  it(`stays total on events nested ${String(DEEP_NESTING)} levels deep`, () => {
    assert.match(refusal(parsedTower('object')), /^SQS event Records absent/);
    assert.ok(refusal({ Records: [sqsRecord({ body: parsedTower('array') })] }).length < 1_000);
  });
});
