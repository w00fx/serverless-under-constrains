// The stored-item wire contract with DynamoDB and its stream consumers.
// - AttributeValue data type descriptors: S string, N number as a string, BOOL, NULL true,
//   L list, M map (https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_AttributeValue.html).
// - Table key schema: string partition key `pk` and string sort key `sk` (design §9.3).
// - The controller's stream filter matches `dynamodb.NewImage.record_type.S` (design §9.5, F-2),
//   so a journal item must carry `record_type` as an S attribute.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decodeStoredItem,
  encodeAttributeMap,
  encodeAttributeValue,
} from '../../../src/durable-store/attribute-value-codec.ts';
import type { AttributeMap } from '../../../src/durable-store/attribute-value-codec.ts';
import type { StoredItem } from '../../../src/durable-store/item-store-port.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { passesFilters, parseFilterPattern } from '../../support/durable-store/stream-filter.ts';

const CALLER_TIMEOUT_FILTER =
  '{"eventName":["INSERT"],"dynamodb":{"NewImage":{"record_type":{"S":["caller_timeout_recorded"]}}}}';

// A journal item shaped like a BR-RUA-033 event (envelope fields plus correlation fields).
const JOURNAL_ITEM: StoredItem = {
  pk: '3f1c2a9e-8b4d-4c1e-9f00-1a2b3c4d5e6f#7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  sk: 'conventional_caller#0c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d5#000000000003',
  schema_version: 1,
  record_type: 'caller_timeout_recorded',
  event_id: '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9',
  occurred_at: '2026-10-05T12:00:03.001Z',
  source_sequence: 3,
  causation_event_ids: ['1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'],
  elapsed_ns: '3000000123',
  optional_null_with_meaning: null,
  flags: { aborted: true },
};

// Lambda receives stream records as JSON, so the filter sees the JSON form of the image.
function streamRecord(eventName: string, newImage: AttributeMap): JsonValue {
  return JSON.parse(JSON.stringify({ eventName, dynamodb: { NewImage: newImage } })) as JsonValue;
}

describe('stored-item AttributeValue contract', () => {
  it('encodes every JSON type as its documented data type descriptor', () => {
    assert.deepEqual(encodeAttributeMap(JOURNAL_ITEM), {
      pk: { S: '3f1c2a9e-8b4d-4c1e-9f00-1a2b3c4d5e6f#7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' },
      sk: { S: 'conventional_caller#0c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d5#000000000003' },
      schema_version: { N: '1' },
      record_type: { S: 'caller_timeout_recorded' },
      event_id: { S: '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9' },
      occurred_at: { S: '2026-10-05T12:00:03.001Z' },
      source_sequence: { N: '3' },
      causation_event_ids: { L: [{ S: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' }] },
      elapsed_ns: { S: '3000000123' },
      optional_null_with_meaning: { NULL: true },
      flags: { M: { aborted: { BOOL: true } } },
    });
  });

  it('keeps decimal strings as strings and safe-integer amounts as numbers (BR-RUA-033)', () => {
    assert.deepEqual(encodeAttributeValue('10000'), { S: '10000' });
    assert.deepEqual(encodeAttributeValue(10000), { N: '10000' });
    assert.deepEqual(decodeStoredItem({ pk: { S: 'p' }, sk: { S: 's' }, a: { S: '10000' }, b: { N: '10000' } }), {
      ok: true,
      value: { pk: 'p', sk: 's', a: '10000', b: 10000 },
    });
  });

  it('round-trips a journal item exactly, preserving omitted versus null', () => {
    const decoded = decodeStoredItem(encodeAttributeMap(JOURNAL_ITEM));
    assert.deepEqual(decoded, { ok: true, value: JOURNAL_ITEM });
    assert.ok(decoded.ok);
    assert.equal(Object.hasOwn(decoded.value, 'trial_manifest_sha256'), false);
  });

  it('encodes record_type so the controller stream filter matches the INSERT', () => {
    const pattern = parseFilterPattern(CALLER_TIMEOUT_FILTER);
    const newImage = encodeAttributeMap(JOURNAL_ITEM);
    assert.equal(passesFilters([pattern], streamRecord('INSERT', newImage)), true);
    assert.equal(passesFilters([pattern], streamRecord('MODIFY', newImage)), false);
    const other = encodeAttributeMap({ ...JOURNAL_ITEM, record_type: 'attempt_registered' });
    assert.equal(passesFilters([pattern], streamRecord('INSERT', other)), false);
  });
});
