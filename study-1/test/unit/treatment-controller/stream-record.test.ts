// Reading one caller-journal stream record (design §9.5, F-2): total unmarshalling, the INSERT
// and record-type re-check, and the mapping filter stated once as data.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { encodeAttributeMap } from '../../../src/durable-store/attribute-value-codec.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import {
  CALLER_TIMEOUT_RECORD_TYPE,
  CONTROLLER_STREAM_FILTER,
  isConsumableInsert,
  unmarshallStreamRecord,
} from '../../../src/treatment-controller/stream-record.ts';
import { nestedArrays, nestedMapAttribute } from '../../support/transport-rehearsal/deep-values.ts';
import { callerTimeoutImage, streamInsert } from './support/controller-fixtures.ts';

const IMAGE = callerTimeoutImage('probe');

function rawRecord(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    eventID: '1',
    eventName: 'INSERT',
    dynamodb: { SequenceNumber: '000000000000000000007', NewImage: encodeAttributeMap(IMAGE) },
    ...overrides,
  };
}

function malformed(detail: string): object {
  return { ok: false, error: { code: 'STREAM_RECORD_MALFORMED', subject: 'caller_journal_stream_record', detail } };
}

describe('unmarshallStreamRecord', () => {
  it('reads the event name, the decoded new image and the sequence number', () => {
    assert.deepEqual(unmarshallStreamRecord(rawRecord()), {
      ok: true,
      value: { event_name: 'INSERT', new_image: IMAGE, sequence_number: '000000000000000000007' },
    });
  });

  it('refuses a record that is not an object', () => {
    assert.deepEqual(unmarshallStreamRecord(null), malformed('stream record is null; expected an object'));
    assert.deepEqual(unmarshallStreamRecord([rawRecord()]), malformed('stream record is array; expected an object'));
    assert.deepEqual(unmarshallStreamRecord('INSERT'), malformed('stream record is string; expected an object'));
  });

  it('refuses a missing event name or change body', () => {
    assert.deepEqual(
      unmarshallStreamRecord(rawRecord({ eventName: 1 })),
      malformed('eventName is number and dynamodb is object; expected a string and an object'),
    );
    assert.deepEqual(
      unmarshallStreamRecord(rawRecord({ dynamodb: undefined })),
      malformed('eventName is string and dynamodb is undefined; expected a string and an object'),
    );
  });

  it('refuses a missing sequence number', () => {
    assert.deepEqual(
      unmarshallStreamRecord(rawRecord({ dynamodb: { NewImage: encodeAttributeMap(IMAGE) } })),
      malformed('dynamodb.SequenceNumber is undefined; expected a string'),
    );
  });

  it('refuses a new image the codec cannot decode, naming the sequence number', () => {
    const result = unmarshallStreamRecord(
      rawRecord({ dynamodb: { SequenceNumber: '9', NewImage: { pk: { S: 'p' } } } }),
    );
    assert.equal(result.ok, false);
    assert.match(result.error.detail, /^dynamodb\.NewImage of 9: item key is pk=/);
    const removed = unmarshallStreamRecord(rawRecord({ eventName: 'REMOVE', dynamodb: { SequenceNumber: '9' } }));
    assert.equal(removed.ok, false);
  });
});

function withImage(image: JsonValue): Readonly<Record<string, unknown>> {
  return rawRecord({ dynamodb: { SequenceNumber: '5', NewImage: image } });
}

function nestedImage(levels: number): JsonValue {
  return { pk: { S: 'p' }, sk: { S: 's' }, deep: nestedMapAttribute(levels) };
}

// DynamoDB stores at most 32 nested levels of lists and maps
// (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html, "Nested
// attribute depth"); the store's decoder refuses anything deeper, naming the first path past it.
const DYNAMODB_NESTED_LEVELS = 32;
const TOO_DEEP = new RegExp(
  `^dynamodb\\.NewImage of 5: \\$\\.deep(\\.a){${String(DYNAMODB_NESTED_LEVELS)}} nests deeper than 32 levels; expected at most 32 levels of lists and maps`,
);

function assertMalformed(result: ReturnType<typeof unmarshallStreamRecord>, detail: RegExp): void {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'STREAM_RECORD_MALFORMED');
  assert.equal(result.error.subject, 'caller_journal_stream_record');
  assert.match(result.error.detail, detail);
}

describe('unmarshallStreamRecord nesting (A-05; review r1: decoding overflowed at 1,563 levels)', () => {
  it("reads an image at DynamoDB's 32 nested levels and refuses one level deeper", () => {
    const atLimit = unmarshallStreamRecord(withImage(nestedImage(DYNAMODB_NESTED_LEVELS)));
    assert.equal(atLimit.ok, true);
    let leaf: unknown = atLimit.value.new_image['deep'];
    for (let level = 0; level < DYNAMODB_NESTED_LEVELS; level += 1) {
      leaf = (leaf as Readonly<Record<string, unknown>>)['a'];
    }
    assert.equal(leaf, 'leaf');
    assertMalformed(unmarshallStreamRecord(withImage(nestedImage(DYNAMODB_NESTED_LEVELS + 1))), TOO_DEEP);
  });

  it('refuses an image nested 100,000 levels deep without throwing', () => {
    assertMalformed(unmarshallStreamRecord(withImage(nestedImage(100_000))), TOO_DEEP);
    assertMalformed(
      unmarshallStreamRecord(withImage({ pk: { S: 'p' }, sk: { S: 's' }, deep: nestedArrays(100_000) })),
      /^dynamodb\.NewImage of 5: \$\.deep is an array of length 1; expected an AttributeValue object$/,
    );
  });

  it('refuses a cyclic image without throwing, and reads equal attribute objects as equal values', () => {
    const cyclic: Record<string, unknown> = { M: {} };
    (cyclic['M'] as Record<string, unknown>)['a'] = cyclic;
    assertMalformed(
      unmarshallStreamRecord(withImage({ pk: { S: 'p' }, sk: { S: 's' }, c: cyclic } as unknown as JsonValue)),
      /^dynamodb\.NewImage of 5: \$\.c(\.a){32} nests deeper than 32 levels/,
    );
    const shared = { S: 'x' };
    assert.deepEqual(unmarshallStreamRecord(withImage({ pk: { S: 'p' }, sk: { S: 's' }, a: shared, b: shared })), {
      ok: true,
      value: { event_name: 'INSERT', new_image: { pk: 'p', sk: 's', a: 'x', b: 'x' }, sequence_number: '5' },
    });
    assert.deepEqual(
      unmarshallStreamRecord(withImage({ pk: { S: 'p' }, sk: { S: 's' }, n: { L: [null] } })),
      malformed('dynamodb.NewImage of 5: $.n[0] is null; expected an AttributeValue object'),
    );
  });
});

describe('unmarshallStreamRecord hostile members (A-05)', () => {
  it('refuses non-finite numbers: an image number DynamoDB cannot store, or a parsed 1e400 member', () => {
    for (const text of ['1e400', '-1e400']) {
      assertMalformed(
        unmarshallStreamRecord(withImage({ pk: { S: 'p' }, sk: { S: 's' }, n: { N: text } })),
        /^dynamodb\.NewImage of 5: \$\.n\.N is "-?1e400"; expected a finite number/,
      );
    }
    const overflowing: unknown = JSON.parse('{"eventName":"INSERT","dynamodb":{"SequenceNumber":1e400}}');
    assert.deepEqual(
      unmarshallStreamRecord(overflowing),
      malformed('dynamodb.SequenceNumber is number; expected a string'),
    );
    assert.deepEqual(
      unmarshallStreamRecord(rawRecord({ eventName: Number.NaN })),
      malformed('eventName is number and dynamodb is object; expected a string and an object'),
    );
  });

  it('reads only own members: inherited ones are absent, and own inherited names are plain data', () => {
    assert.deepEqual(
      unmarshallStreamRecord(Object.create(rawRecord()) as unknown),
      malformed('eventName is undefined and dynamodb is undefined; expected a string and an object'),
    );
    const parsed: unknown = JSON.parse(
      '{"__proto__":{"eventName":"MODIFY"},"eventName":"INSERT","dynamodb":{"SequenceNumber":"5","NewImage":' +
        '{"pk":{"S":"p"},"sk":{"S":"s"},"__proto__":{"S":"x"},"constructor":{"M":{"toString":{"N":"1"}}}}}}',
    );
    const result = unmarshallStreamRecord(parsed);
    assert.ok(result.ok);
    assert.equal(result.value.event_name, 'INSERT');
    assert.equal(Object.hasOwn(result.value.new_image, '__proto__'), true);
    assert.equal(result.value.new_image['__proto__'], 'x');
    assert.deepEqual(result.value.new_image.constructor, { toString: 1 });
    assert.equal(Object.getPrototypeOf(result.value.new_image), Object.prototype);
    assert.equal(isConsumableInsert(result.value), false);
  });
});

describe('isConsumableInsert', () => {
  it('accepts only an INSERT of caller_timeout_recorded', () => {
    assert.equal(isConsumableInsert(streamInsert(IMAGE)), true);
    assert.equal(isConsumableInsert(streamInsert(IMAGE, 'MODIFY')), false);
    assert.equal(isConsumableInsert(streamInsert({ ...IMAGE, record_type: 'dispatch_started' })), false);
    assert.equal(isConsumableInsert(streamInsert({ pk: 'p', sk: 'state#attempt#x' })), false);
  });
});

describe('CONTROLLER_STREAM_FILTER', () => {
  it('is the design §9.5 pattern: INSERTs whose new image is a caller timeout', () => {
    assert.equal(CALLER_TIMEOUT_RECORD_TYPE, 'caller_timeout_recorded');
    assert.deepEqual(CONTROLLER_STREAM_FILTER, {
      eventName: ['INSERT'],
      dynamodb: { NewImage: { record_type: { S: ['caller_timeout_recorded'] } } },
    });
  });
});
