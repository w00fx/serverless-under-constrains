// The golden builder's deterministic values and its journal event log: label-derived identities,
// the fixed timeline, the BR-RUA-033 envelope with dense per-instance sequences, the time-order
// guard of a source instance, and the collector's export order (design §9.3).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isUuid4 } from '../../../src/record-contract/identifiers.ts';
import type { Sha256Hex, Uuid4 } from '../../../src/record-contract/primitives.ts';
import {
  compareCodeUnits,
  GoldenEventLog,
  recordNumber,
  recordText,
  sortedJournal,
} from '../../support/golden-builder/golden-event-log.ts';
import type { EventLogScope } from '../../support/golden-builder/golden-event-log.ts';
import { goldenUuid, instantAt, labelDigest, usd } from '../../support/golden-builder/golden-values.ts';
import { DEEP_NESTING, parsedJson, parsedTower } from '../../support/kernel/deep-json.ts';

const RUN_ID = goldenUuid('unit/run');
const TRIAL_ID = goldenUuid('unit/trial');
const SCOPE: EventLogScope = {
  label: 'unit',
  identity: { run_id: RUN_ID },
  execution_manifest_sha256: labelDigest('unit/execution-manifest'),
  trial: { trial_id: TRIAL_ID, trial_manifest_sha256: labelDigest('unit/trial-manifest') },
};

describe('golden values', () => {
  it('derives a stable lowercase UUIDv4 per label and distinct ids for distinct labels', () => {
    assert.equal(goldenUuid('a'), goldenUuid('a'));
    assert.notEqual(goldenUuid('a'), goldenUuid('b'));
    const ids = Array.from({ length: 64 }, (_, index) => goldenUuid(`label-${String(index)}`));
    assert.ok(ids.every((id) => isUuid4(id)));
    assert.equal(new Set(ids.map((id) => id.charAt(19))).size > 1, true, 'the variant nibble varies over 8-b');
  });

  it('derives 64-hex label digests distinct from the uuid derivation of the same label', () => {
    assert.match(labelDigest('x'), /^[0-9a-f]{64}$/);
    assert.notEqual(labelDigest('x'), labelDigest('y'));
    assert.notEqual(labelDigest('x').slice(0, 8), goldenUuid('x').slice(0, 8));
  });

  it('places offsets on the 2026-10-05T12:00Z timeline and rejects negative or fractional ones', () => {
    assert.equal(instantAt(0), '2026-10-05T12:00:00.000Z');
    assert.equal(instantAt(90_061_001), '2026-10-06T13:01:01.001Z');
    assert.throws(() => instantAt(-1), /timeline offset -1 ms; expected a nonnegative safe integer/);
    assert.throws(() => instantAt(0.5), /timeline offset 0.5 ms/);
    assert.throws(() => instantAt(Number.NaN), /timeline offset NaN ms/);
  });

  it('passes a money decimal through unchanged', () => {
    assert.equal(usd('5.00'), '5.00');
  });
});

describe('golden event log', () => {
  it('stamps the envelope and numbers each instance densely from 1', () => {
    const log = new GoldenEventLog(SCOPE);
    const caller = log.instance('conventional_caller', 'delivery-1');
    const provider = log.instance('refund_provider', 'call-1');
    const first = caller.emit('caller_invocation_started', 400, { lambda_request_id: 'r-1' });
    provider.emit('provider_call_received', 450, { provider_call_id: 'p' }, [first]);
    caller.emit('attempt_registered', 450, {});
    const records = log.events().map((event) => event.record);
    assert.deepEqual(
      records.map((record) => [record['source'], record['source_sequence']]),
      [
        ['conventional_caller', 1],
        ['refund_provider', 1],
        ['conventional_caller', 2],
      ],
    );
    assert.deepEqual(records[0], {
      lambda_request_id: 'r-1',
      schema_version: 1,
      record_type: 'caller_invocation_started',
      event_id: first,
      run_id: RUN_ID,
      execution_manifest_sha256: SCOPE.execution_manifest_sha256,
      trial_id: TRIAL_ID,
      trial_manifest_sha256: SCOPE.trial?.trial_manifest_sha256,
      occurred_at: '2026-10-05T12:00:00.400Z',
      source: 'conventional_caller',
      source_instance_id: caller.instance_id,
      source_sequence: 1,
    });
    assert.deepEqual(records[1]?.['causation_event_ids'], [first]);
    assert.equal(Object.hasOwn(records[2] ?? {}, 'causation_event_ids'), false, 'a causal root omits causation');
  });

  it('sorts and deduplicates causation', () => {
    const log = new GoldenEventLog(SCOPE);
    const instance = log.instance('runner', 'r');
    const [a, b] = [goldenUuid('cause-a'), goldenUuid('cause-b')].toSorted() as [Uuid4, Uuid4];
    instance.emit('settlement_assessed', 1, {}, [b, a, b]);
    assert.deepEqual(log.events()[0]?.record['causation_event_ids'], [a, b]);
  });

  it('omits trial fields for an execution-scoped log and keeps the body under the envelope', () => {
    const log = new GoldenEventLog({
      label: 'x',
      identity: { transport_probe_id: RUN_ID },
      execution_manifest_sha256: 'e' as Sha256Hex,
    });
    log.instance('runner', 'r').emit('phase_transition_recorded', 0, { record_type: 'overridden', status: 'started' });
    const record = log.events()[0]?.record ?? {};
    assert.equal(record['record_type'], 'phase_transition_recorded');
    assert.equal(record['transport_probe_id'], RUN_ID);
    assert.equal(Object.hasOwn(record, 'trial_id'), false);
  });

  it('refuses a second instance with the same source and label, but not across sources', () => {
    const log = new GoldenEventLog(SCOPE);
    log.instance('refund_provider', 'same');
    log.instance('conventional_caller', 'same');
    assert.throws(() => log.instance('refund_provider', 'same'), /source instance refund_provider\/same opened twice/);
  });

  it('refuses to emit earlier than the instance last emitted, and gives fresh ids per event', () => {
    const log = new GoldenEventLog(SCOPE);
    const instance = log.instance('refund_provider', 'call');
    const first = instance.emit('provider_call_received', 100, {});
    const second = instance.emit('provider_call_accepted', 100, {});
    assert.notEqual(first, second);
    assert.throws(
      () => instance.emit('provider_call_rejected', 99, {}),
      /refund_provider\/call emits provider_call_rejected at 99 ms after an event at 100 ms; expected time order/,
    );
    assert.equal(log.events().length, 2);
  });

  it('exports journals by source, instance id and zero-padded sequence', () => {
    const log = new GoldenEventLog(SCOPE);
    const a = log.instance('refund_provider', 'a');
    const b = log.instance('conventional_caller', 'b');
    for (let index = 0; index < 11; index += 1) {
      a.emit('provider_call_received', index, {});
    }
    b.emit('caller_invocation_started', 0, {});
    const keys = sortedJournal(log.events()).map(
      (record) => `${recordText(record, 'source')}:${recordText(record, 'source_sequence')}`,
    );
    assert.deepEqual(keys, [
      'conventional_caller:1',
      ...Array.from({ length: 11 }, (_, i) => `refund_provider:${String(i + 1)}`),
    ]);
  });

  it('compares by code units and reads only string or number members as text', () => {
    assert.equal(compareCodeUnits('a', 'a'), 0);
    assert.equal(compareCodeUnits('B', 'a'), -1);
    assert.equal(compareCodeUnits('é', 'z'), 1);
    assert.equal(recordText({ a: 'x', b: 3, c: true, d: null, e: [1] }, 'a'), 'x');
    assert.equal(recordText({ b: 3 }, 'b'), '3');
    assert.equal(recordText({ c: true }, 'c'), '');
    assert.equal(recordText({ e: { f: 1 } }, 'e'), '');
    assert.equal(recordText({}, 'toString'), '');
  });

  // A-05 regression (WP-09 single-pass review): `Number()` threw on both hostile values below.
  it('reads only number members as numbers, without coercing any other value', () => {
    assert.equal(recordNumber({ n: 3 }, 'n'), 3);
    assert.equal(recordNumber({ n: -1.5 }, 'n'), -1.5);
    assert.ok(Number.isNaN(recordNumber({ n: '3' }, 'n')));
    assert.ok(Number.isNaN(recordNumber({}, 'n')));
    assert.ok(Number.isNaN(recordNumber({}, 'valueOf')));
    assert.ok(Number.isNaN(recordNumber({ n: parsedJson('{"valueOf":1,"toString":1}') }, 'n')));
    assert.ok(Number.isNaN(recordNumber({ n: parsedTower('array', DEEP_NESTING) }, 'n')));
  });
});
