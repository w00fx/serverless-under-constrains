// Reading one caller-journal stream record (design §9.5, F-2): total unmarshalling, the INSERT
// and record-type re-check, and the mapping filter stated once as data.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { encodeAttributeMap } from '../../../src/durable-store/attribute-value-codec.ts';
import {
  CALLER_TIMEOUT_RECORD_TYPE,
  CONTROLLER_STREAM_FILTER,
  isConsumableInsert,
  unmarshallStreamRecord,
} from '../../../src/treatment-controller/stream-record.ts';
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
