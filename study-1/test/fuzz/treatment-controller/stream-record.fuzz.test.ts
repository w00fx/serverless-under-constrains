// Property-based tests of the controller's untrusted-input boundary: the raw DynamoDB stream
// record (testing rule 6; design §9.5, F-2). `unmarshallStreamRecord` is total over any value,
// including images nested far deeper than the call stack (review r1: decoding overflowed at
// 1,563 levels), and an image within the nesting bound is decoded, never refused for depth,
// so a record the controller cannot read never loops the shard; a readable record round-trips
// its event name, sequence number and image; and, through the composed controller over the
// store emulator, a record that is not an INSERT of `caller_timeout_recorded` is ignored and
// writes nothing, even in a partition whose treatment a valid event would signal.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { encodeAttributeMap } from '../../../src/durable-store/attribute-value-codec.ts';
import type { StoredItem } from '../../../src/durable-store/item-store-port.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import {
  CALLER_TIMEOUT_RECORD_TYPE,
  MAX_IMAGE_ATTRIBUTE_LEVELS,
  isConsumableInsert,
  unmarshallStreamRecord,
} from '../../../src/treatment-controller/stream-record.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { nestedArrays, nestedMapAttribute } from '../../support/transport-rehearsal/deep-values.ts';
import {
  PROBE,
  PROBE_PK,
  callerTimeoutImage,
  committedTreatmentItem,
  controllerHarness,
  probeConfigItem,
  streamInsert,
} from '../../unit/treatment-controller/support/controller-fixtures.ts';

// Weighted toward the consumable values, so both sides of `isConsumableInsert` occur often.
const eventName = fc.oneof(
  { weight: 2, arbitrary: fc.constant('INSERT') },
  fc.constantFrom('MODIFY', 'REMOVE', 'insert', 'INSERT ', ''),
  fc.string({ maxLength: 8 }),
);
const recordType = fc.oneof(
  { weight: 2, arbitrary: fc.constant<JsonValue>(CALLER_TIMEOUT_RECORD_TYPE) },
  fc.constantFrom<JsonValue>(
    'dispatch_started',
    'attempt_outcome_recorded',
    'caller_timeout_recorded ',
    'CALLER_TIMEOUT_RECORDED',
    '',
    null,
    1,
    true,
  ),
  fc.string({ maxLength: 8 }),
);

// An image the codec can encode: keys, then any JSON values the store accepts.
const imageExtras: fc.Arbitrary<JsonObject> = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 6 }).filter((key) => key !== 'pk' && key !== 'sk'),
  fc.oneof(fc.string({ maxLength: 6 }), fc.integer(), fc.boolean(), fc.constant(null)),
  { maxKeys: 3 },
);

const wellFormedRaw = fc
  .tuple(eventName, recordType, fc.string({ maxLength: 12 }), imageExtras)
  .map(([name, type, sequence, extras]) => ({
    raw: {
      eventName: name,
      dynamodb: {
        SequenceNumber: sequence,
        NewImage: encodeAttributeMap({ ...callerTimeoutImage('probe'), ...extras, record_type: type }),
      },
    },
    name,
    type,
    sequence,
  }));

// Raw records broken at one level: wrong container types, missing members, non-attribute images.
const brokenRaw: fc.Arbitrary<unknown> = fc.oneof(
  fc.anything(),
  fc.record({ eventName: fc.anything(), dynamodb: fc.anything() }),
  fc.record({
    eventName,
    dynamodb: fc.record({ SequenceNumber: fc.anything(), NewImage: fc.anything() }, { requiredKeys: [] }),
  }),
);

// A raw record whose image nests `levels` maps (or plain arrays) under one attribute.
const nestedRaw = (levels: number, maps: boolean): Readonly<Record<string, unknown>> => ({
  eventName: 'INSERT',
  dynamodb: {
    SequenceNumber: '1',
    NewImage: { pk: { S: 'p' }, sk: { S: 's' }, deep: maps ? nestedMapAttribute(levels) : nestedArrays(levels) },
  },
});
const deepRaw = fc
  .tuple(fc.integer({ min: MAX_IMAGE_ATTRIBUTE_LEVELS + 1, max: 4_000 }), fc.boolean())
  .map(([levels, maps]) => nestedRaw(levels, maps));

describe('stream record properties', () => {
  it('reads any value without throwing, into a record or a structured STREAM_RECORD_MALFORMED reason', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          brokenRaw,
          wellFormedRaw.map((entry) => entry.raw),
          deepRaw,
        ),
        (raw) => {
          const result = unmarshallStreamRecord(raw);
          if (result.ok) {
            assert.equal(typeof result.value.sequence_number, 'string');
            assert.equal(typeof result.value.new_image.pk, 'string');
            return;
          }
          assert.equal(result.error.code, 'STREAM_RECORD_MALFORMED');
          assert.equal(result.error.subject, 'caller_journal_stream_record');
          assert.ok(result.error.detail.length > 0);
        },
      ),
      fuzzParameters(),
    );
  });

  it('decodes every image of nested maps within the bound and refuses every deeper one', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 3 * MAX_IMAGE_ATTRIBUTE_LEVELS }), (levels) => {
        const result = unmarshallStreamRecord(nestedRaw(levels, true));
        assert.equal(result.ok, levels <= MAX_IMAGE_ATTRIBUTE_LEVELS, String(levels));
      }),
      fuzzParameters(),
    );
  });

  it('round-trips the event name, the sequence number and the image of a well-formed record', () => {
    // Both consumable and non-consumable records must be exercised.
    const seen = { consumable: 0, other: 0 };
    fc.assert(
      fc.property(wellFormedRaw, ({ raw, name, type, sequence }) => {
        const result = unmarshallStreamRecord(raw);
        seen[name === 'INSERT' && type === CALLER_TIMEOUT_RECORD_TYPE ? 'consumable' : 'other'] += 1;
        assert.ok(result.ok, JSON.stringify(raw));
        assert.equal(result.value.event_name, name);
        assert.equal(result.value.sequence_number, sequence);
        assert.deepEqual(result.value.new_image['record_type'], type);
        assert.equal(isConsumableInsert(result.value), name === 'INSERT' && type === CALLER_TIMEOUT_RECORD_TYPE);
      }),
      fuzzParameters(),
    );
    assert.ok(seen.consumable > 0 && seen.other > 0, JSON.stringify(seen));
  });

  it('through the controller, a record that is not an INSERT of a caller timeout is ignored and writes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(eventName, recordType, async (name, type) => {
        fc.pre(!(name === 'INSERT' && type === CALLER_TIMEOUT_RECORD_TYPE));
        const harness = controllerHarness(PROBE);
        harness.store.seed('control', probeConfigItem());
        harness.store.seed('control', committedTreatmentItem(PROBE_PK));
        const before: readonly StoredItem[] = harness.store.itemsIn('control');
        const image = callerTimeoutImage('probe', { record_type: type });
        const outcome = await harness.controller.handle(streamInsert(image, name));
        assert.equal(outcome.outcome, 'record_ignored');
        assert.equal(outcome.partition_key, null);
        assert.deepEqual(harness.store.itemsIn('experiment_journal'), []);
        assert.deepEqual(harness.store.itemsIn('control'), before);
      }),
      fuzzParameters(),
    );
  });
});
