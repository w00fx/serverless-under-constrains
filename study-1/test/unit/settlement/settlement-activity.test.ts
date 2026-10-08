// Design §8.12 `quiet(s)` and `activity(s, prev)` as restart causes: each condition of a quiet
// sample, each change since the previous sample, the vocabulary order and the two sample flags the
// closed cause vocabulary maps to its nearest cause (evidence/WP-14/decisions.md).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { activityCauses, quietViolations } from '../../../src/settlement/settlement-activity.ts';
import { quietSample } from './support/settlement-samples.ts';

const QUIET = quietSample(30_000);

describe('quietViolations', () => {
  it('finds nothing in a quiet sample, with every not_applicable marker', () => {
    assert.deepEqual(quietViolations(QUIET), []);
    assert.deepEqual(
      quietViolations(
        quietSample(0, {
          source_queue: 'not_applicable',
          dlq: 'not_applicable',
          inner_executions_terminal: true,
          treatment_terminal: true,
        }),
      ),
      [],
    );
  });

  it('names each source counter that is not zero', () => {
    assert.deepEqual(quietViolations(quietSample(0, { source_queue: { visible: 1, in_flight: 0, delayed: 0 } })), [
      'SOURCE_VISIBLE',
    ]);
    assert.deepEqual(quietViolations(quietSample(0, { source_queue: { visible: 0, in_flight: 2, delayed: 0 } })), [
      'SOURCE_IN_FLIGHT',
    ]);
    assert.deepEqual(quietViolations(quietSample(0, { source_queue: { visible: 0, in_flight: 0, delayed: 3 } })), [
      'SOURCE_DELAYED',
    ]);
  });

  it('never treats unavailable counters as quiet', () => {
    assert.deepEqual(quietViolations(quietSample(0, { source_queue: 'unavailable' })), ['QUEUE_UNAVAILABLE']);
    assert.deepEqual(quietViolations(quietSample(0, { dlq: 'unavailable' })), ['QUEUE_UNAVAILABLE']);
  });

  it('finds a correlated DLQ message the observer has not captured', () => {
    const sample = quietSample(0, { correlated_dlq_message_ids: ['m-1'], dlq_captured_message_ids: [] });
    assert.deepEqual(quietViolations(sample), ['UNCAPTURED_DLQ_MESSAGE']);
    const notApplicable = quietSample(0, { dlq: 'not_applicable', correlated_dlq_message_ids: ['m-1'] });
    assert.deepEqual(quietViolations(notApplicable), ['UNCAPTURED_DLQ_MESSAGE']);
  });

  it('finds more waiting DLQ messages than were captured, and accepts captured ones', () => {
    const waiting = quietSample(0, {
      dlq: { visible: 1, in_flight: 1, delayed: 0 },
      dlq_captured_message_ids: ['m-1'],
    });
    assert.deepEqual(quietViolations(waiting), ['UNCAPTURED_DLQ_MESSAGE']);
    const captured = quietSample(0, {
      dlq: { visible: 1, in_flight: 0, delayed: 0 },
      correlated_dlq_message_ids: ['m-1'],
      dlq_captured_message_ids: ['m-1'],
    });
    assert.deepEqual(quietViolations(captured), []);
  });

  it('names provider activity of each kind', () => {
    for (const changes of [
      { provider_active_calls: 1 },
      { provider_held_barriers: 1 },
      { provider_pending_releases: 1 },
    ]) {
      assert.deepEqual(quietViolations(quietSample(0, changes)), ['PROVIDER_ACTIVE'], JSON.stringify(changes));
    }
  });

  it('names processing, inner executions and treatment that are not terminal', () => {
    assert.deepEqual(quietViolations(quietSample(0, { processing_terminal: false })), ['PROCESSING_NOT_TERMINAL']);
    assert.deepEqual(quietViolations(quietSample(0, { inner_executions_terminal: false })), ['INNER_EXECUTION_ACTIVE']);
    assert.deepEqual(quietViolations(quietSample(0, { treatment_terminal: false })), ['TREATMENT_NOT_TERMINAL']);
  });

  it('maps a publication that has not stopped and an impossible ledger snapshot to their nearest causes', () => {
    assert.deepEqual(quietViolations(quietSample(0, { publication_stopped: false })), ['PROCESSING_NOT_TERMINAL']);
    assert.deepEqual(quietViolations(quietSample(0, { ledger_snapshot_possible: false })), ['LEDGER_ACTIVITY']);
  });
});

describe('activityCauses', () => {
  it('judges the first sample on quietness alone', () => {
    assert.deepEqual(
      activityCauses(quietSample(0, { correlated_event_watermark: 99, ledger_item_count: 7 }), undefined),
      [],
    );
  });

  it('finds no activity between two equal quiet samples, nor a falling watermark', () => {
    assert.deepEqual(activityCauses(QUIET, QUIET), []);
    assert.deepEqual(activityCauses(quietSample(60_000, { correlated_event_watermark: 4 }), QUIET), []);
  });

  it('finds a rising journal watermark, a changed ledger count and a new correlated DLQ message', () => {
    assert.deepEqual(activityCauses(quietSample(60_000, { correlated_event_watermark: 6 }), QUIET), [
      'CORRELATED_JOURNAL_ACTIVITY',
    ]);
    assert.deepEqual(activityCauses(quietSample(60_000, { ledger_item_count: 0 }), QUIET), ['LEDGER_ACTIVITY']);
    const captured = { correlated_dlq_message_ids: ['m-1'], dlq_captured_message_ids: ['m-1'] };
    assert.deepEqual(activityCauses(quietSample(60_000, captured), QUIET), ['NEW_CORRELATED_DLQ_MESSAGE']);
    assert.deepEqual(activityCauses(quietSample(90_000, captured), quietSample(60_000, captured)), []);
  });

  it('lists every cause once, in vocabulary order', () => {
    const busy = quietSample(60_000, {
      source_queue: 'unavailable',
      dlq: 'unavailable',
      ledger_snapshot_possible: false,
      ledger_item_count: 3,
      processing_terminal: false,
      publication_stopped: false,
      correlated_event_watermark: 9,
      treatment_terminal: false,
      inner_executions_terminal: false,
      provider_active_calls: 2,
      correlated_dlq_message_ids: ['m-2'],
    });
    assert.deepEqual(activityCauses(busy, QUIET), [
      'NEW_CORRELATED_DLQ_MESSAGE',
      'UNCAPTURED_DLQ_MESSAGE',
      'CORRELATED_JOURNAL_ACTIVITY',
      'LEDGER_ACTIVITY',
      'PROVIDER_ACTIVE',
      'PROCESSING_NOT_TERMINAL',
      'INNER_EXECUTION_ACTIVE',
      'TREATMENT_NOT_TERMINAL',
      'QUEUE_UNAVAILABLE',
    ]);
  });
});
