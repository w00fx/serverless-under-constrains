// The SQS event a Durable execution starts from (design §9.5, BatchSize 1): exactly one record
// with a message id, a body and a positive receive count, parsed totally (Owner amendment A-05:
// deep nesting, non-finite numbers, inherited member names).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DURABLE_MESSAGE_ID_LIMIT,
  parseDurableSqsDelivery,
} from '../../../src/durable-variant/durable-sqs-delivery.ts';
import { parseJsonDocument } from '../../../src/record-contract/parsing.ts';
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
  const parsed = parseDurableSqsDelivery(event);
  assert.equal(parsed.ok, false);
  return parsed.error;
}

function parsedText(text: string): JsonValue {
  const parsed = parseJsonDocument(new TextEncoder().encode(text));
  assert.ok(parsed.ok, text);
  return parsed.value;
}

describe('parseDurableSqsDelivery', () => {
  it('reads the message id, body and receive count of the single record', () => {
    assert.deepEqual(
      parseDurableSqsDelivery({ Records: [sqsRecord({ attributes: { ApproximateReceiveCount: '2' } })] }),
      {
        ok: true,
        value: {
          message_id: 'f5a3c0de-0000-4000-8000-000000000001',
          approximate_receive_count: 2,
          body: '{"record_type":"trial_message"}\n',
        },
      },
    );
  });

  it(`accepts a message id of ${String(DURABLE_MESSAGE_ID_LIMIT)} characters and a 15-digit receive count`, () => {
    const parsed = parseDurableSqsDelivery({
      Records: [
        sqsRecord({
          messageId: 'm'.repeat(DURABLE_MESSAGE_ID_LIMIT),
          attributes: { ApproximateReceiveCount: '9'.repeat(15) },
        }),
      ],
    });
    assert.deepEqual(parsed, {
      ok: true,
      value: {
        message_id: 'm'.repeat(128),
        approximate_receive_count: 999_999_999_999_999,
        body: '{"record_type":"trial_message"}\n',
      },
    });
  });

  it('refuses an event that is not one record', () => {
    assert.equal(refusal({}), 'SQS event Records absent; expected an array of exactly one record (BatchSize 1)');
    assert.equal(refusal(null), 'SQS event Records absent; expected an array of exactly one record (BatchSize 1)');
    assert.equal(
      refusal({ Records: [] }),
      'SQS event Records array []; expected an array of exactly one record (BatchSize 1)',
    );
    assert.match(
      refusal({ Records: [sqsRecord(), sqsRecord()] }),
      /^SQS event Records array \[.*; expected an array of exactly one record/,
    );
    assert.equal(
      refusal([sqsRecord()]),
      'SQS event Records absent; expected an array of exactly one record (BatchSize 1)',
    );
    assert.equal(
      refusal({ Records: 'x' }),
      'SQS event Records string "x"; expected an array of exactly one record (BatchSize 1)',
    );
    assert.equal(refusal({ Records: ['x'] }), 'SQS record string "x"; expected a JSON object');
    assert.equal(refusal({ Records: [[1]] }), 'SQS record array [1]; expected a JSON object');
  });

  it('refuses a record without a usable message id, body or receive count', () => {
    const cases: readonly (readonly [JsonObject, string])[] = [
      [sqsRecord({ messageId: '' }), 'SQS record messageId string ""; expected a string of 1 to 128 characters'],
      [sqsRecord({ messageId: 7 }), 'SQS record messageId number 7; expected a string of 1 to 128 characters'],
      [
        sqsRecord({ messageId: 'm'.repeat(DURABLE_MESSAGE_ID_LIMIT + 1) }),
        `SQS record messageId string "${'m'.repeat(129)}"; expected a string of 1 to 128 characters`,
      ],
      [sqsRecord({ body: null }), 'SQS record body null null; expected a string'],
      [
        sqsRecord({ attributes: null }),
        'SQS record attributes.ApproximateReceiveCount absent; expected a positive decimal integer string',
      ],
      [
        sqsRecord({ attributes: ['1'] }),
        'SQS record attributes.ApproximateReceiveCount absent; expected a positive decimal integer string',
      ],
    ];
    for (const [record, expected] of cases) {
      assert.equal(refusal({ Records: [record] }), expected);
    }
    for (const count of ['0', '01', '-1', '1.5', 'one', '', ' 1', '1'.repeat(16), 1]) {
      assert.equal(
        refusal({ Records: [sqsRecord({ attributes: { ApproximateReceiveCount: count } })] }),
        `SQS record attributes.ApproximateReceiveCount ${typeof count === 'number' ? 'number 1' : `string ${JSON.stringify(count)}`}; expected a positive decimal integer string`,
      );
    }
  });

  it('never reads inherited members as event fields', () => {
    const text =
      '{"Records":[{"__proto__":{"messageId":"m","body":"b"},"attributes":{"ApproximateReceiveCount":"1"}}]}';
    assert.match(refusal(parsedText(text)), /^SQS record messageId absent/);
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      assert.match(refusal(parsedText(`{"Records":[{"messageId":"${name}"}]}`)), /^SQS record body absent/);
      assert.match(refusal(parsedText(`{"${name}":[]}`)), /^SQS event Records absent/);
    }
  });

  it('refuses non-finite numbers in the record with a bounded detail', () => {
    assert.equal(
      refusal({ Records: [sqsRecord({ messageId: Number.POSITIVE_INFINITY })] }),
      'SQS record messageId number Infinity; expected a string of 1 to 128 characters',
    );
    assert.equal(
      refusal({ Records: [sqsRecord({ attributes: { ApproximateReceiveCount: Number.NEGATIVE_INFINITY } })] }),
      'SQS record attributes.ApproximateReceiveCount number -Infinity; expected a positive decimal integer string',
    );
  });

  it(`stays total and bounded on events nested ${String(DEEP_NESTING)} levels deep`, () => {
    assert.match(refusal(parsedTower('object')), /^SQS event Records absent/);
    assert.match(refusal({ Records: parsedTower('array') }), /^SQS record .*; expected a JSON object$/u);
    assert.ok(refusal({ Records: [sqsRecord({ body: parsedTower('array') })] }).length < 1_000);
    assert.ok(refusal({ Records: [parsedTower('mixed')] }).length < 1_000);
  });
});
