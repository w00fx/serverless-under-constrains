// Shared fixtures of the evidence-collection tests: one run with a conventional trial and the
// probe, store items in the shapes the provider, callers and controller write (design §9.3), SQS
// and Lambda durable-execution entries in the SDK shapes, and a schema check every produced record
// goes through. Identities reuse the group-A contract examples so the configuration and
// registration items are the canonical ones.

import assert from 'node:assert/strict';

import type { StoredItem } from '../../../src/durable-store/item-store-port.ts';
import type { CaptureScope, TrialCaptureScope } from '../../../src/evidence-collection/capture-scope.ts';
import type { ReceivedSqsMessage } from '../../../src/evidence-collection/dlq-capture.ts';
import type { SdkDurableExecution, SdkHistoryEvent } from '../../../src/evidence-collection/durable-sdk-mapping.ts';
import { parseJsonDocument, parseJsonl } from '../../../src/record-contract/parsing.ts';
import type { EventSource } from '../../../src/record-contract/envelope.ts';
import type { JsonObject, JsonValue, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { DIGESTS, IDS, uuid } from '../../contract/record-contract/group-a/support/sample-values.ts';
import { VirtualTimeScheduler } from '../kernel/virtual-time-scheduler.ts';

export const RUN_ID = IDS.run;
export const TRIAL_ID = IDS.trial3;
export const EXECUTION = { execution_kind: 'RUN', run_id: RUN_ID } as const;
export const TRIAL_PK = `${RUN_ID}#${TRIAL_ID}`;
export const PROBE_PK = `${RUN_ID}#probe`;
/** 2026-10-05T12:20:00.000Z: the collection instant of every fixture clock. */
export const COLLECTION_EPOCH_MS = Date.UTC(2026, 9, 5, 12, 20);

export const TRIAL_SCOPE: TrialCaptureScope = {
  execution: EXECUTION,
  execution_manifest_sha256: DIGESTS.executionManifest,
  unit: { kind: 'trial', trial_id: TRIAL_ID, trial_manifest_sha256: DIGESTS.trialManifest },
};

export const PROBE_SCOPE: CaptureScope = {
  execution: EXECUTION,
  execution_manifest_sha256: DIGESTS.executionManifest,
  unit: { kind: 'probe' },
};

const validator = createRecordValidator();

/**
 * A virtual clock at the fixture collection instant.
 *
 * @example
 * collectionClock().now().toISOString(); // '2026-10-05T12:20:00.000Z'
 */
export function collectionClock(): VirtualTimeScheduler {
  return new VirtualTimeScheduler({ wallEpochMs: COLLECTION_EPOCH_MS });
}

/**
 * Asserts the value is a valid record of its declared type (catalogue schemas).
 *
 * @example
 * assertValidRecord(ledger.record);
 */
export function assertValidRecord(value: JsonValue, label = 'record'): void {
  const validation = validator.validate(value);
  assert.deepEqual(validation.valid ? [] : validation.violations, [], `${label}: expected a valid record`);
}

/**
 * The record a single-record evidence file holds.
 *
 * @example
 * recordOfBytes(file.bytes)['record_type']; // 'ledger_snapshot'
 */
export function recordOfBytes(bytes: Uint8Array): JsonObject {
  const parsed = parseJsonDocument(bytes);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    throw new Error(`evidence bytes do not hold one JSON object: ${new TextDecoder().decode(bytes).slice(0, 200)}`);
  }
  return parsed.value as JsonObject;
}

/**
 * The records a JSONL evidence file holds, in line order.
 *
 * @example
 * linesOfBytes(file.bytes).length; // 3
 */
export function linesOfBytes(bytes: Uint8Array): readonly JsonValue[] {
  const report = parseJsonl(bytes);
  return report.lines.map((line) => {
    if (!line.parsed.ok) {
      throw new Error(`line ${String(line.line_number)} is not JSON`);
    }
    return line.parsed.value;
  });
}

/**
 * A ledger transaction item of the partition, `tx#<provider_transaction_id>` (design §9.3).
 *
 * @example
 * store.seed('ledger', ledgerItem(TRIAL_PK, 1));
 */
export function ledgerItem(pk: string, serial: number): StoredItem {
  const transactionId = uuid(0x7000 + serial);
  return {
    pk,
    sk: `tx#${transactionId}`,
    provider_transaction_id: transactionId,
    provider_commit_id: uuid(0x7100 + serial),
    provider_call_id: uuid(0x7200 + serial),
    attempt_id: uuid(0x7300 + serial),
    provider_request_id: uuid(0x7400 + serial),
    refund_request_id: 'ref-poc-001',
    payment_id: 'pay-poc-001',
    amount_minor: 10000,
    currency: 'BRL',
    status: 'SUCCEEDED',
    commit_requested_at: '2026-10-05T12:05:01.000Z',
  };
}

/**
 * A journal item under `<source>#<instance>#<sequence:12>` holding `fields` (design §9.3).
 *
 * @example
 * store.seed('experiment_journal', journalItem(TRIAL_PK, 'refund_provider', 1, { record_type: 'provider_call_received' }));
 */
export function journalItem(
  pk: string,
  source: EventSource,
  sequence: number,
  fields: JsonObject,
  instance: Uuid4 = uuid(0x900),
): StoredItem {
  return {
    ...fields,
    pk,
    sk: `${source}#${instance}#${String(sequence).padStart(12, '0')}`,
    source,
    source_sequence: sequence,
  };
}

/**
 * A FIFO dead-letter message as ReceiveMessage returns it with every system attribute.
 *
 * @example
 * dlq.enqueue(sqsMessage({ id: 'm1', group: TRIAL_ID }));
 */
export function sqsMessage(options: {
  readonly id: string;
  readonly group: string;
  readonly body?: string;
  readonly receiveCount?: number;
}): ReceivedSqsMessage {
  return {
    MessageId: options.id,
    Body: options.body ?? `{"trial_id":"${options.group}"}`,
    MD5OfBody: '5041925b48aa53c3d3044a97ee5027f1',
    Attributes: {
      ApproximateReceiveCount: String(options.receiveCount ?? 2),
      ApproximateFirstReceiveTimestamp: String(Date.UTC(2026, 9, 5, 12, 35, 5, 400)),
      SentTimestamp: String(Date.UTC(2026, 9, 5, 12, 35, 5)),
      MessageGroupId: options.group,
      MessageDeduplicationId: options.group,
      SequenceNumber: '18000000000002100000',
    },
  };
}

export const DURABLE_FUNCTION_ARN = 'arn:aws:lambda:us-east-1:012345678901:function:suc1-durable-caller';

/**
 * A durable execution as ListDurableExecutionsByFunction returns it.
 *
 * @example
 * durable.addExecution(sdkExecution(1, 'SUCCEEDED'), [sdkEvent('ExecutionStarted', 1)]);
 */
export function sdkExecution(serial: number, status: string): SdkDurableExecution {
  return {
    DurableExecutionArn: `${DURABLE_FUNCTION_ARN}:3/durable-execution/exec-${String(serial)}/${uuid(0xa00 + serial)}`,
    DurableExecutionName: `exec-${String(serial)}`,
    Status: status,
    StartTimestamp: new Date(Date.UTC(2026, 9, 5, 12, 5, serial)),
    ...(status === 'RUNNING' ? {} : { EndTimestamp: new Date(Date.UTC(2026, 9, 5, 12, 6, serial)) }),
  };
}

/**
 * A history event as GetDurableExecutionHistory returns it.
 *
 * @example
 * sdkEvent('StepFailed', 3, { StepFailedDetails: { RetryDetails: { CurrentAttempt: 1 } } });
 */
export function sdkEvent(
  eventType: string,
  eventId: number,
  extra: Readonly<Record<string, unknown>> = {},
): SdkHistoryEvent {
  return {
    EventType: eventType,
    EventId: eventId,
    EventTimestamp: new Date(Date.UTC(2026, 9, 5, 12, 5, 0, eventId)),
    ...extra,
  };
}
