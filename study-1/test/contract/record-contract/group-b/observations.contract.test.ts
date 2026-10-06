// Observation and snapshot records (catalogue rows 57-65): read outcomes are explicit (a failed
// read is recorded, never omitted), counters are nonnegative safe integers, and the ledger
// snapshot records how it was read so the oracle can judge it (BR-RUA-031, BR-RUA-032).

import { describe, it } from 'node:test';

import type { JsonObject } from '../../../../src/record-contract/primitives.ts';
import type { StudyRecord } from '../../../../src/record-contract/records/index.ts';
import * as observation from './examples/observation-examples.ts';
import { assertAccepted, assertForbidden, assertMissing, assertRejected } from './support/group-b-validation.ts';
import { withMember, withValueAt } from './support/json-paths.ts';
import { RUN_ID, toJson } from './support/record-builders.ts';

function json(record: StudyRecord): JsonObject {
  return toJson(record);
}

const COUNTERS = { visible: 0, in_flight: 0, delayed: 0 };

describe('AC-RUA-046 queue_observation', () => {
  it('a successful read has counters and no error', () => {
    const observed = json(observation.queueCountersObserved());
    assertMissing(withMember(observed, 'counters', undefined), 'ok', 'counters');
    assertForbidden(withMember(observed, 'error_code', 'Throttling'), 'ok with error', '/error_code');
  });

  it('a failed read has an error and no counters', () => {
    const unavailable = json(observation.queueCountersUnavailable());
    assertMissing(withMember(unavailable, 'error_code', undefined), 'unavailable', 'error_code');
    assertForbidden(withMember(unavailable, 'counters', COUNTERS), 'unavailable with counters', '/counters');
    assertRejected(withMember(unavailable, 'read_status', 'absent'), 'absent', '/read_status enum');
  });
});

describe('AC-RUA-046 settlement_sample', () => {
  it('tri-state fields admit a boolean or not_applicable only', () => {
    const sample = json(observation.settlementSample());
    for (const field of ['inner_executions_terminal', 'treatment_terminal']) {
      assertAccepted(withMember(sample, field, false), `${field} false`);
      assertAccepted(withMember(sample, field, 'not_applicable'), `${field} not_applicable`);
      assertRejected(withMember(sample, field, 'unavailable'), `${field} unavailable`, `/${field} anyOf`);
    }
  });

  it('queue fields are counters or an explicit marker', () => {
    const sample = json(observation.settlementSample());
    for (const field of ['source_queue', 'dlq']) {
      assertAccepted(withMember(sample, field, 'not_applicable'), `${field} not_applicable`);
      assertAccepted(withMember(sample, field, COUNTERS), `${field} counters`);
      assertRejected(withMember(sample, field, 'unknown'), `${field} unknown`, `/${field} anyOf`);
      assertRejected(withMember(sample, field, { visible: 0 }), `${field} partial`, `/${field} anyOf`);
    }
  });

  it('message id lists are unique', () => {
    const sample = json(observation.settlementSample());
    const ids = ['message-0002', 'message-0002'];
    assertRejected(
      withMember(sample, 'correlated_dlq_message_ids', ids),
      'dup',
      '/correlated_dlq_message_ids uniqueItems',
    );
    assertRejected(withMember(sample, 'dlq_captured_message_ids', ids), 'dup', '/dlq_captured_message_ids uniqueItems');
    assertRejected(withMember(sample, 'phase', 'settled'), 'phase', '/phase enum');
  });
});

describe('AC-RUA-046 dlq_snapshot', () => {
  it('keeps message bodies verbatim and SQS attributes in their wire formats', () => {
    const snapshot = json(observation.dlqSnapshot());
    assertAccepted(withValueAt(snapshot, ['messages', 0, 'body'], ''), 'empty body');
    assertAccepted(withMember(snapshot, 'messages', []), 'empty DLQ');
    const md5 = 'FEDCBA9876543210FEDCBA9876543210';
    assertRejected(
      withValueAt(snapshot, ['messages', 0, 'md5_of_body'], md5),
      'md5',
      '/messages/0/md5_of_body pattern',
    );
    assertRejected(
      withValueAt(snapshot, ['messages', 0, 'sequence_number'], '2026-10-05'),
      'sequence_number as a date',
      '/messages/0/sequence_number pattern',
    );
  });

  it('SQS message timestamps are millisecond UTC, never the epoch digit strings SQS reports', () => {
    // BR-RUA-033: "Timestamps use UTC `YYYY-MM-DDTHH:mm:ss.SSSZ` with exactly millisecond precision."
    const snapshot = json(observation.dlqSnapshot());
    for (const field of ['sent_timestamp', 'approximate_first_receive_timestamp']) {
      const path = ['messages', 0, field];
      assertAccepted(withValueAt(snapshot, path, '2026-10-05T12:00:00.000Z'), `${field} UTC`);
      assertRejected(withValueAt(snapshot, path, '1791201599000'), `${field} epoch`, `/messages/0/${field} pattern`);
      assertRejected(
        withValueAt(snapshot, path, '2026-10-05T12:00:00Z'),
        `${field} seconds`,
        `/messages/0/${field} pattern`,
      );
    }
  });
});

describe('AC-RUA-046 ledger_snapshot', () => {
  it('records the writer and the read mode for the oracle to judge (G1)', () => {
    const ledger = json(observation.ledgerSnapshot());
    assertAccepted(withMember(ledger, 'writer', 'refund_provider'), 'provider-written');
    assertAccepted(withMember(ledger, 'consistent_read', false), 'eventually consistent read');
    assertAccepted(withMember(ledger, 'complete', false), 'incomplete read');
    assertRejected(withMember(ledger, 'writer', 'operator'), 'unknown writer', '/writer enum');
  });

  it('pages count from 1 and transactions are committed ledger items', () => {
    const ledger = json(observation.ledgerSnapshot());
    assertRejected(withValueAt(ledger, ['pages', 0, 'page_number'], 0), 'page 0', '/pages/0/page_number minimum');
    const status = ['transactions', 0, 'status'];
    assertRejected(withValueAt(ledger, status, 'FAILED'), 'failed tx', '/transactions/0/status enum');
    assertRejected(
      withValueAt(ledger, ['transactions', 0, 'amount_minor'], 0),
      'zero',
      '/transactions/0/amount_minor minimum',
    );
  });
});

describe('AC-RUA-046 treatment_state_snapshot', () => {
  it('an item is recorded exactly when present', () => {
    const present = json(observation.treatmentItemPresent());
    assertMissing(withMember(present, 'treatment', undefined), 'present', 'treatment');
    const absent = json(observation.treatmentItemAbsent());
    const item = present['treatment'] ?? null;
    assertForbidden(withMember(absent, 'treatment', item), 'absent with item', '/treatment');
  });

  it('an item names a catalogued state at a positive version', () => {
    const present = json(observation.treatmentItemPresent());
    assertAccepted(withValueAt(present, ['treatment'], { state: 'ARMED', version: 1 }), 'minimal item');
    assertRejected(withValueAt(present, ['treatment', 'state'], 'DONE'), 'state', '/treatment/state enum');
    assertRejected(withValueAt(present, ['treatment', 'version'], 0), 'version', '/treatment/version minimum');
    assertRejected(withValueAt(present, ['treatment'], { version: 1 }), 'no state', '/treatment required');
  });
});

describe('AC-RUA-046 durable_execution_metadata', () => {
  it('history events keep the service event type spelling', () => {
    const metadata = json(observation.durableExecutionMetadata());
    const eventType = ['executions', 0, 'history', 0, 'event_type'];
    assertAccepted(withValueAt(metadata, eventType, 'ExecutionSucceeded'), 'PascalCase type');
    assertRejected(
      withValueAt(metadata, eventType, 'execution_succeeded'),
      'snake type',
      `/executions/0/history/0/event_type pattern`,
    );
    const minimal = { event_type: 'StepStarted', event_timestamp: '2026-10-05T12:00:00.000Z' };
    assertAccepted(withValueAt(metadata, ['executions', 0, 'history', 0], minimal), 'minimal history event');
  });

  it('names the service history id apart from the study event_id', () => {
    // BR-RUA-033 reserves `event_id` for the study's lowercase UUIDv4 event identity.
    const metadata = json(observation.durableExecutionMetadata());
    const historyEvent = ['executions', 0, 'history', 0];
    assertRejected(
      withValueAt(metadata, [...historyEvent, 'event_id'], 1),
      'service id as event_id',
      '/executions/0/history/0 additionalProperties',
    );
    const historyId = [...historyEvent, 'history_event_id'];
    assertAccepted(withValueAt(metadata, historyId, 0), 'first service id');
    assertRejected(
      withValueAt(metadata, historyId, -1),
      'negative id',
      '/executions/0/history/0/history_event_id minimum',
    );
  });

  it('a running execution may omit its end', () => {
    const metadata = json(observation.durableExecutionMetadata());
    const running = withValueAt(
      withValueAt(metadata, ['executions', 0, 'status'], 'RUNNING'),
      ['executions', 0, 'ended_at'],
      undefined,
    );
    assertAccepted(running, 'running');
    assertRejected(
      withValueAt(metadata, ['executions', 0, 'status'], 'PENDING'),
      'status',
      '/executions/0/status enum',
    );
  });
});

describe('AC-RUA-046 telemetry_availability and pre_cleanup_snapshot', () => {
  it('each signal states its availability', () => {
    const telemetry = json(observation.telemetryAvailability());
    assertRejected(withValueAt(telemetry, ['logs', 'availability'], 'partial'), 'partial', '/logs/availability enum');
    assertRejected(withValueAt(telemetry, ['logs', 'locators', 0], ''), 'empty locator', '/logs/locators/0 minLength');
    assertMissing(withMember(telemetry, 'traces', undefined), 'no traces', 'traces');
  });

  it('a treatment read has a state exactly when it succeeded', () => {
    const snapshot = json(observation.preCleanupSnapshot());
    assertRejected(
      withValueAt(snapshot, ['treatment_states', 0, 'state'], undefined),
      'ok',
      '/treatment_states/0 required',
    );
    const absentWithState = withValueAt(snapshot, ['treatment_states', 1, 'state'], 'ARMED');
    assertForbidden(absentWithState, 'absent with state', '/treatment_states/1/state');
    assertAccepted(withValueAt(snapshot, ['treatment_states', 1, 'read_status'], 'unavailable'), 'unavailable');
  });

  it('a queue read has counters exactly when it succeeded', () => {
    const snapshot = json(observation.preCleanupSnapshot());
    assertRejected(withValueAt(snapshot, ['queues', 0, 'counters'], undefined), 'ok', '/queues/0 required');
    assertForbidden(withValueAt(snapshot, ['queues', 1, 'counters'], COUNTERS), 'unavailable', '/queues/1/counters');
  });

  it('the coordination checkpoint belongs to a transport probe', () => {
    const checkpoint = json(observation.coordinationPrefixCheckpoint());
    const asRun = withMember(withMember(checkpoint, 'transport_probe_id', undefined), 'run_id', RUN_ID);
    assertMissing(asRun, 'run checkpoint', 'transport_probe_id');
    assertRejected(withMember(checkpoint, 'journal_path', '/journal.jsonl'), 'absolute', '/journal_path format');
  });
});
