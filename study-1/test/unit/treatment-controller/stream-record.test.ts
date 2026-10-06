// Reading one caller-journal stream record (design §9.5, F-2): total unmarshalling, the INSERT
// and record-type re-check, and the mapping filter stated once as data.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { encodeAttributeMap } from '../../../src/durable-store/attribute-value-codec.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import {
  CALLER_TIMEOUT_RECORD_TYPE,
  CONTROLLER_STREAM_FILTER,
  MAX_IMAGE_ATTRIBUTE_LEVELS,
  isConsumableInsert,
  unmarshallStreamRecord,
} from '../../../src/treatment-controller/stream-record.ts';
import { nestedMapAttribute } from '../../support/transport-rehearsal/deep-values.ts';
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

const TOO_DEEP =
  'dynamodb.NewImage of 5: nests deeper than 130 containers; expected at most 64 nested attribute levels';

describe('unmarshallStreamRecord nesting bound (review r1: decodeStoredItem overflowed at 1,563 levels)', () => {
  it('reads an image at the bound, twice the 32 levels DynamoDB stores, and refuses one level deeper', () => {
    assert.equal(MAX_IMAGE_ATTRIBUTE_LEVELS, 64);
    const atBound = unmarshallStreamRecord(withImage(nestedImage(64)));
    assert.equal(atBound.ok, true);
    let leaf: unknown = atBound.value.new_image['deep'];
    for (let level = 0; level < 64; level += 1) {
      leaf = (leaf as Readonly<Record<string, unknown>>)['a'];
    }
    assert.equal(leaf, 'leaf');
    assert.deepEqual(unmarshallStreamRecord(withImage(nestedImage(65))), malformed(TOO_DEEP));
  });

  it('refuses an image nested 20,000 levels deep without throwing', () => {
    assert.deepEqual(unmarshallStreamRecord(withImage(nestedImage(20_000))), malformed(TOO_DEEP));
  });

  it('refuses an image that reuses a container, and still reads nulls inside an image', () => {
    const shared = { S: 'x' };
    assert.deepEqual(
      unmarshallStreamRecord(withImage({ pk: { S: 'p' }, sk: { S: 's' }, a: shared, b: shared })),
      malformed('dynamodb.NewImage of 5: reuses a container; expected a tree of AttributeValues'),
    );
    assert.deepEqual(
      unmarshallStreamRecord(withImage({ pk: { S: 'p' }, sk: { S: 's' }, a: { S: 'x' }, b: { S: 'x' } })),
      {
        ok: true,
        value: { event_name: 'INSERT', new_image: { pk: 'p', sk: 's', a: 'x', b: 'x' }, sequence_number: '5' },
      },
    );
    assert.deepEqual(
      unmarshallStreamRecord(withImage({ pk: { S: 'p' }, sk: { S: 's' }, n: { L: [null] } })),
      malformed('dynamodb.NewImage of 5: $.n[0] is null; expected an AttributeValue object'),
    );
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
