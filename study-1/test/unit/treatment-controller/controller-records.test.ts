// The journal record each §9.11 decision writes (catalogue group B rows 39-44), checked against
// the catalogue schemas: causation by the caller event, none for an invalid event, the sorted
// pair for the signal (BR-RUA-013, BR-RUA-025).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDurableJournalPort } from '../../../src/event-journal/durable-journal-port.ts';
import type { JournalScope } from '../../../src/event-journal/journal-scope.ts';
import { JournalWriter } from '../../../src/event-journal/journal-writer.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import { appendDecisionRecord, prepareSignalRecord } from '../../../src/treatment-controller/controller-records.ts';
import type { AppendedDecision } from '../../../src/treatment-controller/controller-records.ts';
import { InMemoryItemStore } from '../../support/durable-store/in-memory-item-store.ts';
import { SequentialUuidSource } from '../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';
import {
  ATTEMPT_ID,
  CALLER_EVENT_ID,
  COMMIT_EVENT_ID,
  MANIFEST_SHA,
  OTHER_CALLER_EVENT_ID,
  PROBE,
  PROVIDER_COMMIT_ID,
  RUN,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  assertSchemaValid,
} from './support/controller-fixtures.ts';

const TRIAL_SCOPE: JournalScope = {
  execution: RUN,
  execution_manifest_sha256: MANIFEST_SHA,
  partition: { kind: 'trial', trial_id: TRIAL_ID, trial_manifest_sha256: TRIAL_MANIFEST_SHA },
};
const CANARY_SCOPE: JournalScope = {
  execution: PROBE,
  execution_manifest_sha256: MANIFEST_SHA,
  partition: { kind: 'canary' },
};
const REFS = { caller_timeout_event_id: CALLER_EVENT_ID, attempt_id: ATTEMPT_ID } as const;

function journal(scope: JournalScope): JournalWriter {
  const time = new VirtualTimeScheduler({ wallEpochMs: Date.UTC(2026, 9, 5, 12, 0, 3) });
  const store = new InMemoryItemStore({ clock: time });
  const ids = new SequentialUuidSource('cccccccc');
  return new JournalWriter({
    port: createDurableJournalPort(store, 'experiment_journal'),
    source: 'treatment_controller',
    instanceId: ids.next(),
    scope,
    clock: time,
    ids,
    maxDefinitiveRetries: 0,
  });
}

async function recordOf(decision: AppendedDecision, scope: JournalScope = TRIAL_SCOPE): Promise<JsonObject> {
  const result = await appendDecisionRecord(journal(scope), decision);
  assert.equal(result.kind, 'appended');
  const event = result.event as unknown as JsonObject;
  assertSchemaValid([event]);
  return event;
}

function pick(record: JsonObject, fields: readonly string[]): JsonObject {
  return Object.fromEntries(fields.flatMap((field) => (field in record ? [[field, record[field] ?? null]] : [])));
}

const ANSWER_FIELDS = [
  'record_type',
  'reason',
  'detail',
  'caller_timeout_event_id',
  'attempt_id',
  'treatment_state',
  'existing_caller_event_id',
  'canary_event_id',
  'causation_event_ids',
  'source',
  'trial_id',
];

describe('appendDecisionRecord', () => {
  it('canary_acknowledged: controller_canary_acknowledged, caused by the canary, without a trial', async () => {
    const record = await recordOf({ kind: 'canary_acknowledged', canary_event_id: CALLER_EVENT_ID }, CANARY_SCOPE);
    assert.deepEqual(pick(record, ANSWER_FIELDS), {
      record_type: 'controller_canary_acknowledged',
      canary_event_id: CALLER_EVENT_ID,
      causation_event_ids: [CALLER_EVENT_ID],
      source: 'treatment_controller',
    });
  });

  it('invalid_event_rejected: caller_timeout_rejected{INVALID_EVENT} as a causal root, with what is readable', async () => {
    const full = await recordOf({ kind: 'invalid_event_rejected', detail: 'bad', ...REFS, treatment_state: 'ARMED' });
    assert.deepEqual(pick(full, ANSWER_FIELDS), {
      record_type: 'caller_timeout_rejected',
      reason: 'INVALID_EVENT',
      detail: 'bad',
      ...REFS,
      treatment_state: 'ARMED',
      source: 'treatment_controller',
      trial_id: TRIAL_ID,
    });
    const bare = await recordOf({ kind: 'invalid_event_rejected', detail: 'unreadable' });
    assert.deepEqual(pick(bare, ANSWER_FIELDS), {
      record_type: 'caller_timeout_rejected',
      reason: 'INVALID_EVENT',
      detail: 'unreadable',
      source: 'treatment_controller',
      trial_id: TRIAL_ID,
    });
  });

  it('control, before-commit and not-targeted rejections: caller_timeout_rejected with their reason and state', async () => {
    const cases: readonly [AppendedDecision, JsonObject][] = [
      [
        { kind: 'control_trial_rejected', ...REFS, detail: 'c' },
        { reason: 'CONTROL_TRIAL', detail: 'c' },
      ],
      [
        { kind: 'before_commit_rejected', ...REFS, detail: 'b' },
        { reason: 'BEFORE_COMMIT', detail: 'b', treatment_state: 'ARMED' },
      ],
      [
        { kind: 'not_targeted_rejected', ...REFS, detail: 'n' },
        { reason: 'NOT_TARGETED', detail: 'n', treatment_state: 'COMMITTED_WAITING' },
      ],
    ];
    for (const [decision, expected] of cases) {
      const record = await recordOf(decision);
      assert.deepEqual(pick(record, ANSWER_FIELDS), {
        record_type: 'caller_timeout_rejected',
        ...REFS,
        ...expected,
        causation_event_ids: [CALLER_EVENT_ID],
        source: 'treatment_controller',
        trial_id: TRIAL_ID,
      });
    }
  });

  it('late, duplicate and conflict answers: their records, caused by the caller event', async () => {
    const cases: readonly [AppendedDecision, JsonObject][] = [
      [
        { kind: 'late_rejected', ...REFS },
        { record_type: 'late_timeout_signal_rejected', treatment_state: 'SAFETY_RELEASED' },
      ],
      [
        { kind: 'duplicate_ignored', ...REFS, treatment_state: 'TIMEOUT_OBSERVED' },
        { record_type: 'timeout_signal_duplicate_observed', treatment_state: 'TIMEOUT_OBSERVED' },
      ],
      [
        {
          kind: 'conflict',
          ...REFS,
          existing_caller_event_id: OTHER_CALLER_EVENT_ID,
          treatment_state: 'RESPONSE_RELEASED',
        },
        {
          record_type: 'timeout_signal_conflict_recorded',
          existing_caller_event_id: OTHER_CALLER_EVENT_ID,
          treatment_state: 'RESPONSE_RELEASED',
        },
      ],
    ];
    for (const [decision, expected] of cases) {
      const record = await recordOf(decision);
      assert.deepEqual(pick(record, ANSWER_FIELDS), {
        ...REFS,
        ...expected,
        causation_event_ids: [CALLER_EVENT_ID],
        source: 'treatment_controller',
        trial_id: TRIAL_ID,
      });
    }
  });
});

describe('prepareSignalRecord', () => {
  it('reserves timeout_signal_recorded caused by the sorted [commit event, caller event] pair', () => {
    const prepared = prepareSignalRecord(journal(TRIAL_SCOPE), {
      kind: 'signal',
      ...REFS,
      causation: [CALLER_EVENT_ID, COMMIT_EVENT_ID],
      provider_commit_id: PROVIDER_COMMIT_ID,
      commit_event_id: COMMIT_EVENT_ID,
    });
    assert.equal(prepared.kind, 'prepared');
    const event = prepared.put.event as unknown as JsonObject;
    assertSchemaValid([event]);
    assert.deepEqual(pick(event, [...ANSWER_FIELDS, 'provider_commit_id', 'provider_commit_event_id']), {
      record_type: 'timeout_signal_recorded',
      ...REFS,
      causation_event_ids: [CALLER_EVENT_ID, COMMIT_EVENT_ID],
      source: 'treatment_controller',
      trial_id: TRIAL_ID,
      provider_commit_id: PROVIDER_COMMIT_ID,
      provider_commit_event_id: COMMIT_EVENT_ID,
    });
  });
});
