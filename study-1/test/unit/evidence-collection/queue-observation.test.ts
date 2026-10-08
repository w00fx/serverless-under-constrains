// Queue counter observations (design §5.3, §8.12; BR-RUA-032, RK-14): the three approximate
// counters parsed from SQS attribute strings, total over untrusted input, and a failed read
// recorded as unavailable, which settlement never treats as quiet.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  countersJson,
  observeQueue,
  parseQueueCounterAttributes,
  QUEUE_COUNTER_ATTRIBUTES,
} from '../../../src/evidence-collection/queue-observation.ts';
import {
  assertValidRecord,
  collectionClock,
  TRIAL_SCOPE,
} from '../../support/evidence-collection/collection-fixtures.ts';
import { ScriptedQueueCounterReader } from '../../support/evidence-collection/scripted-queue-counter-reader.ts';

const SOURCE = {
  queue_url: 'https://sqs.us-east-1.amazonaws.com/012345678901/suc1-src.fifo',
  queue_name: 'suc1-src.fifo',
};
const ATTRIBUTES = {
  ApproximateNumberOfMessages: '1',
  ApproximateNumberOfMessagesNotVisible: '2',
  ApproximateNumberOfMessagesDelayed: '0',
};

describe('parseQueueCounterAttributes', () => {
  it('reads the three counters', () => {
    assert.deepEqual(parseQueueCounterAttributes(ATTRIBUTES), {
      ok: true,
      value: { visible: 1, in_flight: 2, delayed: 0 },
    });
    assert.deepEqual(Object.values(QUEUE_COUNTER_ATTRIBUTES), Object.keys(ATTRIBUTES));
  });

  it('refuses each malformed counter, naming it and its value', () => {
    for (const name of Object.keys(ATTRIBUTES)) {
      for (const bad of ['-1', '01', '1.5', '', '9007199254740993', 'Infinity']) {
        const parsed = parseQueueCounterAttributes({ ...ATTRIBUTES, [name]: bad });
        assert.ok(!parsed.ok, `${name}=${bad}`);
        assert.match(parsed.error, new RegExp(`^queue attribute ${name} is "`));
      }
      const { [name]: _dropped, ...without } = ATTRIBUTES as Record<string, string>;
      const parsedWithout = parseQueueCounterAttributes(without);
      assert.ok(!parsedWithout.ok);
      assert.match(
        parsedWithout.error,
        new RegExp(`^queue attribute ${name} is absent; expected a non-negative decimal integer string$`),
      );
    }
    assert.equal(parseQueueCounterAttributes(undefined).ok, false);
  });

  it('never reads an inherited counter (A-05)', () => {
    const inherited = Object.create(ATTRIBUTES) as Record<string, string>;
    assert.equal(parseQueueCounterAttributes(inherited).ok, false);
  });
});

describe('observeQueue', () => {
  it('records a successful read with its counters', async () => {
    const reader = new ScriptedQueueCounterReader();
    reader.setCounters(SOURCE.queue_url, { visible: 0, in_flight: 1, delayed: 0 });
    const observation = await observeQueue(reader, SOURCE, 'source', TRIAL_SCOPE, collectionClock());
    assertValidRecord(observation.record, 'queue_observation');
    assert.deepEqual(observation.counters, { visible: 0, in_flight: 1, delayed: 0 });
    assert.equal(observation.record['read_status'], 'ok');
    assert.equal(observation.record['queue_role'], 'source');
    assert.equal(observation.record['queue_name'], 'suc1-src.fifo');
    assert.equal(observation.record['observed_at'], '2026-10-05T12:20:00.000Z');
  });

  it('records a failed read as unavailable with its error code', async () => {
    const reader = new ScriptedQueueCounterReader();
    reader.scriptFailure(SOURCE.queue_url, 'ThrottlingException');
    const observation = await observeQueue(reader, SOURCE, 'dlq', TRIAL_SCOPE, collectionClock());
    assertValidRecord(observation.record, 'unavailable queue_observation');
    assert.equal(observation.counters, 'unavailable');
    assert.equal(observation.record['error_code'], 'ThrottlingException');
    assert.equal('counters' in observation.record, false);
  });

  it('copies counters into a plain record object', () => {
    const counters = { visible: 3, in_flight: 0, delayed: 1, extra: 9 };
    assert.deepEqual(countersJson(counters), { visible: 3, in_flight: 0, delayed: 1 });
  });
});
