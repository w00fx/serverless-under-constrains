// Canonical observation and snapshot examples (catalogue rows 57-65): the evidence the runner
// and cleanup capture from AWS reads (BR-RUA-031, BR-RUA-032, BR-RUA-048).

import type { CoordinationPrefixCheckpoint } from '../../../../../src/record-contract/records/group-b/coordination_prefix_checkpoint.ts';
import type { DlqSnapshot } from '../../../../../src/record-contract/records/group-b/dlq_snapshot.ts';
import type { DurableExecutionMetadata } from '../../../../../src/record-contract/records/group-b/durable_execution_metadata.ts';
import type { LedgerSnapshot } from '../../../../../src/record-contract/records/group-b/ledger_snapshot.ts';
import type { PreCleanupSnapshot } from '../../../../../src/record-contract/records/group-b/pre_cleanup_snapshot.ts';
import type {
  QueueCountersObserved,
  QueueCountersUnavailable,
} from '../../../../../src/record-contract/records/group-b/queue_observation.ts';
import type { SettlementSample } from '../../../../../src/record-contract/records/group-b/settlement_sample.ts';
import type { ExecutionCorrelation } from '../../../../../src/record-contract/records/group-b/shared-shapes.ts';
import type { TelemetryAvailabilityRecord } from '../../../../../src/record-contract/records/group-b/telemetry_availability.ts';
import type { TreatmentStateSnapshot } from '../../../../../src/record-contract/records/group-b/treatment_state_snapshot.ts';
import { DURABLE_EXECUTION_ARN } from './caller-examples.ts';
import {
  ATTEMPT_CORRELATION,
  COMMIT_TRIPLE,
  EXECUTION_MANIFEST_SHA256,
  PAYMENT_ID,
  PROBE_ID,
  RUN_ID,
  TRIAL_PARTITION,
  TRIAL_SCOPE,
  at,
  digest,
  reason,
  uuid,
} from '../support/record-builders.ts';
import { example } from '../support/record-example.ts';
import type { RecordExample } from '../support/record-example.ts';

const RUN_CORRELATION: ExecutionCorrelation = { run_id: RUN_ID, execution_manifest_sha256: EXECUTION_MANIFEST_SHA256 };
const SOURCE_QUEUE = 'rua-run-0100-source.fifo';
const DLQ = 'rua-run-0100-dlq.fifo';

/**
 * Source-queue counters read successfully.
 *
 * @example
 * toJson(queueCountersObserved());
 */
export function queueCountersObserved(): ExecutionCorrelation & QueueCountersObserved {
  return {
    schema_version: 1,
    record_type: 'queue_observation',
    ...RUN_CORRELATION,
    ...TRIAL_SCOPE,
    queue_role: 'source',
    queue_name: SOURCE_QUEUE,
    observed_at: at(50_000),
    read_status: 'ok',
    counters: { visible: 0, in_flight: 1, delayed: 0 },
  };
}

/**
 * A DLQ read that failed.
 *
 * @example
 * toJson(queueCountersUnavailable());
 */
export function queueCountersUnavailable(): ExecutionCorrelation & QueueCountersUnavailable {
  return {
    schema_version: 1,
    record_type: 'queue_observation',
    ...RUN_CORRELATION,
    ...TRIAL_SCOPE,
    queue_role: 'dlq',
    queue_name: DLQ,
    observed_at: at(50_000),
    read_status: 'unavailable',
    error_code: 'AWS.SimpleQueueService.NonExistentQueue',
  };
}

/**
 * One settlement-loop sample of a trial.
 *
 * @example
 * toJson(settlementSample());
 */
export function settlementSample(): SettlementSample {
  return {
    schema_version: 1,
    record_type: 'settlement_sample',
    ...RUN_CORRELATION,
    ...TRIAL_SCOPE,
    observed_at: at(60_000),
    phase: 'observation',
    publication_stopped: true,
    processing_terminal: true,
    inner_executions_terminal: 'not_applicable',
    provider_active_calls: 0,
    provider_held_barriers: 0,
    provider_pending_releases: 0,
    treatment_terminal: true,
    ledger_snapshot_possible: true,
    source_queue: { visible: 0, in_flight: 0, delayed: 0 },
    dlq: 'unavailable',
    correlated_dlq_message_ids: ['message-0002'],
    dlq_captured_message_ids: ['message-0002'],
    correlated_event_watermark: 41,
    ledger_item_count: 2,
  };
}

/**
 * The trial's DLQ contents, captured in full.
 *
 * @example
 * toJson(dlqSnapshot());
 */
export function dlqSnapshot(): DlqSnapshot {
  return {
    schema_version: 1,
    record_type: 'dlq_snapshot',
    ...RUN_CORRELATION,
    ...TRIAL_SCOPE,
    queue_name: DLQ,
    captured_at: at(61_000),
    receive_complete: true,
    messages: [
      {
        message_id: 'message-0002',
        body: '{"refund_request_id":"refund-request-0001"}',
        body_sha256: digest('dlq-body'),
        md5_of_body: 'fedcba9876543210fedcba9876543210',
        approximate_receive_count: 3,
        approximate_first_receive_timestamp: at(59_500),
        sent_timestamp: at(59_000),
        message_group_id: 'group-0001',
        message_deduplication_id: 'dedup-0001',
        sequence_number: '18889000000000000002',
      },
    ],
  };
}

/**
 * The trial's ledger partition, read consistently in one page.
 *
 * @example
 * toJson(ledgerSnapshot());
 */
export function ledgerSnapshot(): LedgerSnapshot {
  return {
    schema_version: 1,
    record_type: 'ledger_snapshot',
    ...RUN_CORRELATION,
    ...TRIAL_SCOPE,
    writer: 'evidence_collector',
    partition_key: TRIAL_PARTITION,
    consistent_read: true,
    captured_at: at(62_000),
    complete: true,
    pages: [{ page_number: 1, item_count: 1, start_cursor: 'cursor-0', next_cursor: 'cursor-1' }],
    transactions: [
      {
        ...COMMIT_TRIPLE,
        attempt_id: ATTEMPT_CORRELATION.attempt_id,
        provider_request_id: ATTEMPT_CORRELATION.provider_request_id,
        refund_request_id: ATTEMPT_CORRELATION.refund_request_id,
        payment_id: PAYMENT_ID,
        amount_minor: 1250,
        currency: 'EUR',
        status: 'SUCCEEDED',
        commit_requested_at: at(20),
      },
    ],
  };
}

/**
 * The trial's treatment item after its response was released.
 *
 * @example
 * toJson(treatmentItemPresent());
 */
export function treatmentItemPresent(): TreatmentStateSnapshot {
  return {
    schema_version: 1,
    record_type: 'treatment_state_snapshot',
    ...RUN_CORRELATION,
    ...TRIAL_SCOPE,
    partition_key: TRIAL_PARTITION,
    captured_at: at(63_000),
    consistent_read: true,
    item_present: true,
    treatment: {
      state: 'RESPONSE_RELEASED',
      version: 5,
      targeted_attempt_id: ATTEMPT_CORRELATION.attempt_id,
      provider_request_id: ATTEMPT_CORRELATION.provider_request_id,
      provider_call_id: COMMIT_TRIPLE.provider_call_id,
      provider_commit_id: COMMIT_TRIPLE.provider_commit_id,
      provider_transaction_id: COMMIT_TRIPLE.provider_transaction_id,
      commit_event_id: uuid(14),
      signal_event_id: uuid(23),
      signal_caller_event_id: uuid(6),
      observed_event_id: uuid(17),
      release_event_id: uuid(18),
    },
  };
}

/**
 * A treatment item the provider released at its safety deadline while it waited after commit:
 * the barrier writes `safety_release_cause` only on the transition to SAFETY_RELEASED
 * (refund-provider treatment-barrier), so only this state carries it.
 *
 * @example
 * toJson(treatmentItemSafetyReleased());
 */
export function treatmentItemSafetyReleased(): TreatmentStateSnapshot {
  return {
    schema_version: 1,
    record_type: 'treatment_state_snapshot',
    ...RUN_CORRELATION,
    ...TRIAL_SCOPE,
    partition_key: TRIAL_PARTITION,
    captured_at: at(63_000),
    consistent_read: true,
    item_present: true,
    treatment: {
      state: 'SAFETY_RELEASED',
      version: 3,
      targeted_attempt_id: ATTEMPT_CORRELATION.attempt_id,
      provider_request_id: ATTEMPT_CORRELATION.provider_request_id,
      provider_call_id: COMMIT_TRIPLE.provider_call_id,
      provider_commit_id: COMMIT_TRIPLE.provider_commit_id,
      provider_transaction_id: COMMIT_TRIPLE.provider_transaction_id,
      commit_event_id: uuid(14),
      safety_release_cause: 'SAFETY_DEADLINE',
    },
  };
}

/**
 * A treatment partition with no item (a CONTROL trial).
 *
 * @example
 * toJson(treatmentItemAbsent());
 */
export function treatmentItemAbsent(): TreatmentStateSnapshot {
  return {
    schema_version: 1,
    record_type: 'treatment_state_snapshot',
    ...RUN_CORRELATION,
    ...TRIAL_SCOPE,
    partition_key: TRIAL_PARTITION,
    captured_at: at(63_000),
    consistent_read: true,
    item_present: false,
  };
}

/**
 * The trial's Durable executions and their history.
 *
 * @example
 * toJson(durableExecutionMetadata());
 */
export function durableExecutionMetadata(): DurableExecutionMetadata {
  return {
    schema_version: 1,
    record_type: 'durable_execution_metadata',
    ...RUN_CORRELATION,
    ...TRIAL_SCOPE,
    function_arn: 'arn:aws:lambda:eu-west-1:111122223333:function:rua-durable-caller',
    qualifier: '7',
    captured_at: at(64_000),
    started_after: at(0),
    list_complete: true,
    executions: [
      {
        durable_execution_arn: DURABLE_EXECUTION_ARN,
        durable_execution_name: 'refund-0001',
        status: 'SUCCEEDED',
        started_at: at(1),
        ended_at: at(4000),
        version: '7',
        history_complete: true,
        history: [
          {
            history_event_id: 1,
            event_type: 'StepStarted',
            event_timestamp: at(2),
            name: 'refund',
            current_attempt: 1,
            next_attempt_delay_seconds: 2,
            request_id: '7f9c1a2e-request',
            error_type: 'TimeoutError',
          },
        ],
      },
    ],
  };
}

/**
 * Telemetry availability of the run (execution level).
 *
 * @example
 * toJson(telemetryAvailability());
 */
export function telemetryAvailability(): TelemetryAvailabilityRecord {
  return {
    schema_version: 1,
    record_type: 'telemetry_availability',
    ...RUN_CORRELATION,
    captured_at: at(65_000),
    logs: { availability: 'available', locators: ['/aws/lambda/rua-run-0100-caller'], reasons: [] },
    metrics: { availability: 'available', locators: ['AWS/Lambda Errors'], reasons: [] },
    traces: { availability: 'unavailable', locators: [], reasons: [reason('TRACES_NOT_INDEXED', 'xray')] },
  };
}

/**
 * The operational state before an emergency cleanup.
 *
 * @example
 * toJson(preCleanupSnapshot());
 */
export function preCleanupSnapshot(): PreCleanupSnapshot {
  return {
    schema_version: 1,
    record_type: 'pre_cleanup_snapshot',
    ...RUN_CORRELATION,
    captured_at: at(66_000),
    cleanup_mode: 'EMERGENCY',
    treatment_states: [
      { partition_key: TRIAL_PARTITION, read_status: 'ok', state: 'COMMITTED_WAITING', version: 2 },
      { partition_key: `${RUN_ID}#absent`, read_status: 'absent' },
    ],
    provider_activity: [{ partition_key: TRIAL_PARTITION, active_calls: 1, held_barriers: 1, pending_releases: 0 }],
    durable_executions: [{ durable_execution_arn: DURABLE_EXECUTION_ARN, status: 'RUNNING' }],
    queues: [
      { queue_name: SOURCE_QUEUE, read_status: 'ok', counters: { visible: 1, in_flight: 0, delayed: 0 } },
      { queue_name: DLQ, read_status: 'unavailable' },
    ],
    failures: [reason('DLQ_READ_FAILED', 'sqs')],
  };
}

/**
 * A checkpoint of the probe's coordination journal prefix.
 *
 * @example
 * toJson(coordinationPrefixCheckpoint());
 */
export function coordinationPrefixCheckpoint(): CoordinationPrefixCheckpoint {
  return {
    schema_version: 1,
    record_type: 'coordination_prefix_checkpoint',
    transport_probe_id: PROBE_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    journal_path: 'journal/coordination.jsonl',
    prefix_byte_count: 4096,
    prefix_sha256: digest('journal-prefix'),
    last_event_id: uuid(40),
    last_source_sequence: 12,
    checkpointed_at: at(67_000),
  };
}

// A treatment item carries its commit and signal identities only as far as they exist
// (treatment_state_snapshot schema), so each one may be absent.
const TREATMENT_COMMIT_IDENTITIES = [
  'targeted_attempt_id',
  'provider_request_id',
  'provider_call_id',
  'provider_commit_id',
  'provider_transaction_id',
  'commit_event_id',
];
const TREATMENT_IDENTITIES = [
  ...TREATMENT_COMMIT_IDENTITIES,
  'signal_event_id',
  'signal_caller_event_id',
  'observed_event_id',
  'release_event_id',
];
// GetDurableExecutionHistory fills these per event type only; event type and time are always there.
const DURABLE_HISTORY_DETAILS = [
  'history_event_id',
  'name',
  'current_attempt',
  'next_attempt_delay_seconds',
  'request_id',
  'error_type',
];

export const OBSERVATION_EXAMPLES: readonly RecordExample[] = [
  example('queue_observation ok', queueCountersObserved()),
  example('queue_observation unavailable', queueCountersUnavailable()),
  example('settlement_sample', settlementSample()),
  example('dlq_snapshot', dlqSnapshot()),
  example('ledger_snapshot', ledgerSnapshot(), { nested_optional: ['/pages/*/start_cursor', '/pages/*/next_cursor'] }),
  example('treatment_state_snapshot present', treatmentItemPresent(), {
    nested_optional: TREATMENT_IDENTITIES.map((member) => `/treatment/${member}`),
  }),
  example('treatment_state_snapshot safety released', treatmentItemSafetyReleased(), {
    nested_optional: [...TREATMENT_COMMIT_IDENTITIES, 'safety_release_cause'].map((member) => `/treatment/${member}`),
  }),
  example('treatment_state_snapshot absent', treatmentItemAbsent()),
  example('durable_execution_metadata', durableExecutionMetadata(), {
    nested_optional: [
      '/executions/*/ended_at',
      '/executions/*/version',
      ...DURABLE_HISTORY_DETAILS.map((member) => `/executions/*/history/*/${member}`),
    ],
  }),
  example('telemetry_availability', telemetryAvailability()),
  example('pre_cleanup_snapshot', preCleanupSnapshot()),
  example('coordination_prefix_checkpoint', coordinationPrefixCheckpoint()),
];
