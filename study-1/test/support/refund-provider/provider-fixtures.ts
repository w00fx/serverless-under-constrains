// Shared fixtures of the refund-provider tests: fixed identities (the OR-RUA-001 financial
// fixture), valid calls, the control items the runner writes (design §9.3), and a harness that
// composes the real provider over the InMemoryItemStore emulator (WP-04) on virtual time.
// They live in `test/support/refund-provider/` (WP-07 by Owner amendment A-11) because the unit,
// integration and fuzz suites of the provider and WP-08's transport rehearsal all import them.

import type { StoredItem } from '../../../src/durable-store/item-store-port.ts';
import type { JournalEvent } from '../../../src/event-journal/journal-event.ts';
import { executionIdOf } from '../../../src/event-journal/journal-scope.ts';
import type { EventRecordType } from '../../../src/record-contract/record-types.ts';
import type {
  ExecutionIdentity,
  JsonObject,
  JsonValue,
  Scenario,
  Sha256Hex,
  Uuid4,
} from '../../../src/record-contract/primitives.ts';
import type { TreatmentState } from '../../../src/record-contract/records/group-b/vocabulary.ts';
import { composeRefundProvider } from '../../../src/refund-provider/provider-composition.ts';
import type { RefundProvider } from '../../../src/refund-provider/refund-provider.ts';
import { InMemoryItemStore } from '../durable-store/in-memory-item-store.ts';
import { RecordingMutationLog } from '../kernel/recording-mutation-log.ts';
import { SequentialUuidSource } from '../kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../kernel/virtual-time-scheduler.ts';
import { ProviderLogRecorder } from './provider-log-recorder.ts';

export const RUN_ID = 'aaaaaaaa-0000-4000-8000-000000000001' as Uuid4;
export const PROBE_ID = 'aaaaaaaa-0000-4000-8000-000000000002' as Uuid4;
export const VALIDATION_ID = 'aaaaaaaa-0000-4000-8000-000000000003' as Uuid4;
export const OTHER_RUN_ID = 'aaaaaaaa-0000-4000-8000-000000000009' as Uuid4;
export const TRIAL_ID = 'bbbbbbbb-0000-4000-8000-000000000001' as Uuid4;
export const OTHER_TRIAL_ID = 'bbbbbbbb-0000-4000-8000-000000000002' as Uuid4;
export const ATTEMPT_ID = 'dddddddd-0000-4000-8000-000000000001' as Uuid4;
export const PROVIDER_REQUEST_ID = 'dddddddd-0000-4000-8000-000000000002' as Uuid4;
export const SIGNAL_EVENT_ID = 'eeeeeeee-0000-4000-8000-000000000001' as Uuid4;
export const WARMUP_ID = 'ffffffff-0000-4000-8000-000000000001' as Uuid4;
export const MANIFEST_SHA = 'a'.repeat(64) as Sha256Hex;
export const TRIAL_MANIFEST_SHA = 'b'.repeat(64) as Sha256Hex;
export const OTHER_SHA = 'c'.repeat(64) as Sha256Hex;
export const PAYMENT_ID = 'pay-poc-001';
export const REFUND_REQUEST_ID = 'ref-poc-001';
export const EPOCH_MS = Date.UTC(2026, 9, 5, 12, 0, 0, 0);

export const RUN: ExecutionIdentity = { execution_kind: 'RUN', run_id: RUN_ID };
export const PROBE: ExecutionIdentity = { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: PROBE_ID };
export const VALIDATION: ExecutionIdentity = {
  execution_kind: 'VARIANT_VALIDATION',
  variant_validation_id: VALIDATION_ID,
};

export const TRIAL_PK = `${RUN_ID}#${TRIAL_ID}`;
export const PROBE_PK = `${PROBE_ID}#probe`;
/** The run's execution-level journal partition for calls that name no configured trial (A-09). */
export const RUN_PROVIDER_PK = `${RUN_ID}#provider`;

/** A valid trial-scoped call of the conventional caller (OR-RUA-001 fixture values). */
export function validCall(overrides: JsonObject = {}): JsonObject {
  return {
    schema_version: 1,
    record_type: 'provider_refund_call',
    caller_id: 'conventional',
    run_id: RUN_ID,
    execution_manifest_sha256: MANIFEST_SHA,
    trial_id: TRIAL_ID,
    trial_manifest_sha256: TRIAL_MANIFEST_SHA,
    attempt_id: ATTEMPT_ID,
    provider_request_id: PROVIDER_REQUEST_ID,
    refund_request_id: REFUND_REQUEST_ID,
    payment_id: PAYMENT_ID,
    amount_minor: 10000,
    currency: 'BRL',
    ...overrides,
  };
}

/** A valid call of the probe caller (no trial, D-06). */
export function validProbeCall(overrides: JsonObject = {}): JsonObject {
  return {
    schema_version: 1,
    record_type: 'provider_refund_call',
    caller_id: 'probe',
    transport_probe_id: PROBE_ID,
    execution_manifest_sha256: MANIFEST_SHA,
    attempt_id: ATTEMPT_ID,
    provider_request_id: PROVIDER_REQUEST_ID,
    refund_request_id: REFUND_REQUEST_ID,
    payment_id: PAYMENT_ID,
    amount_minor: 10000,
    currency: 'BRL',
    ...overrides,
  };
}

/** A call object without one property (to break the schema's required set). */
export function withoutProperty(call: JsonObject, property: string): JsonObject {
  return Object.fromEntries(Object.entries(call).filter(([key]) => key !== property));
}

/** The `config` item the runner writes for a run trial (`provider_trial_configuration`). */
export function trialConfigItem(scenario: Scenario, overrides: JsonObject = {}): StoredItem {
  return {
    pk: TRIAL_PK,
    sk: 'config',
    schema_version: 1,
    record_type: 'provider_trial_configuration',
    run_id: RUN_ID,
    execution_manifest_sha256: MANIFEST_SHA,
    trial_id: TRIAL_ID,
    trial_manifest_sha256: TRIAL_MANIFEST_SHA,
    registered_caller_id: 'conventional',
    scenario,
    payment_id: PAYMENT_ID,
    safety_release_ms: 15000,
    treatment_poll_interval_ms: 250,
    written_at: '2026-10-05T11:59:00.000Z',
    ...overrides,
  };
}

/** The `config` item of a transport probe: always COMMIT_THEN_TIMEOUT, no trial. */
export function probeConfigItem(overrides: JsonObject = {}): StoredItem {
  return {
    pk: PROBE_PK,
    sk: 'config',
    schema_version: 1,
    record_type: 'provider_trial_configuration',
    transport_probe_id: PROBE_ID,
    execution_manifest_sha256: MANIFEST_SHA,
    registered_caller_id: 'probe',
    scenario: 'COMMIT_THEN_TIMEOUT',
    payment_id: PAYMENT_ID,
    safety_release_ms: 15000,
    treatment_poll_interval_ms: 250,
    written_at: '2026-10-05T11:59:00.000Z',
    ...overrides,
  };
}

/**
 * The execution-level `config` item the runner writes at execution start
 * (`provider_execution_configuration`, Owner amendment A-09).
 */
export function executionConfigItem(execution: ExecutionIdentity = RUN, overrides: JsonObject = {}): StoredItem {
  const { execution_kind: kind, ...identity } = execution;
  return {
    pk: `${executionIdOf(execution)}#execution`,
    sk: 'config',
    schema_version: 1,
    record_type: 'provider_execution_configuration',
    execution_kind: kind,
    ...identity,
    execution_manifest_sha256: MANIFEST_SHA,
    written_at: '2026-10-05T11:58:00.000Z',
    ...overrides,
  };
}

/** The trial payment item (CTR-RUA-005, OR-RUA-001). */
export function paymentItem(pk: string, overrides: JsonObject = {}): StoredItem {
  return {
    pk,
    sk: `payment#${PAYMENT_ID}`,
    schema_version: 1,
    record_type: 'payment',
    payment_id: PAYMENT_ID,
    captured_amount_minor: 10000,
    currency: 'BRL',
    ...overrides,
  };
}

/** The armed treatment item the runner writes before publication. */
export function armedTreatmentItem(pk: string): StoredItem {
  return { pk, sk: 'treatment', state: 'ARMED', version: 1 };
}

export interface ProviderHarness {
  readonly store: InMemoryItemStore;
  readonly time: VirtualTimeScheduler;
  readonly ids: SequentialUuidSource;
  readonly log: RecordingMutationLog;
  /** The provider's diagnostic log lines. */
  readonly providerLogs: ProviderLogRecorder;
  readonly provider: RefundProvider;
}

/** The real provider over an empty InMemoryItemStore on virtual time. */
export function providerHarness(deployment: ExecutionIdentity = RUN): ProviderHarness {
  const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS, monotonicOriginNs: 5_000_000_000n });
  const log = new RecordingMutationLog();
  const store = new InMemoryItemStore({ clock: time, mutationLog: log });
  const ids = new SequentialUuidSource('99999999');
  const providerLogs = new ProviderLogRecorder();
  const provider = composeRefundProvider({
    deployment,
    store,
    ids,
    wall: time,
    monotonic: time,
    sleeper: time,
    log: providerLogs.sink,
  });
  return { store, time, ids, log, providerLogs, provider };
}

/** Seeds a run trial: configuration, payment and, for COMMIT_THEN_TIMEOUT, the armed treatment. */
export function seedRunTrial(harness: ProviderHarness, scenario: Scenario): void {
  harness.store.seed('control', trialConfigItem(scenario));
  harness.store.seed('control', paymentItem(TRIAL_PK));
  if (scenario === 'COMMIT_THEN_TIMEOUT') {
    harness.store.seed('control', armedTreatmentItem(TRIAL_PK));
  }
}

/** Seeds the execution configuration the runner writes before anything else (A-09). */
export function seedExecutionConfiguration(harness: ProviderHarness, execution: ExecutionIdentity = RUN): void {
  harness.store.seed('control', executionConfigItem(execution));
}

/** Seeds the transport-probe partition: configuration, payment and the armed treatment. */
export function seedProbe(harness: ProviderHarness): void {
  harness.store.seed('control', probeConfigItem());
  harness.store.seed('control', paymentItem(PROBE_PK));
  harness.store.seed('control', armedTreatmentItem(PROBE_PK));
}

/** The provider events of a partition, in journal order (source instance, then sequence). */
export function providerEvents(harness: ProviderHarness, pk: string): readonly JournalEvent[] {
  return harness.store
    .itemsIn('experiment_journal')
    .filter((item) => item.pk === pk)
    .map((item) => {
      const { pk: _pk, sk: _sk, ...event } = item;
      return event as unknown as JournalEvent;
    });
}

/** The record types of a partition's provider events, in journal order. */
export function providerEventTypes(harness: ProviderHarness, pk: string): readonly string[] {
  return providerEvents(harness, pk).map((event) => event.record_type);
}

/** The single provider event of one type in a partition; throws when there is not exactly one. */
export function onlyEvent(harness: ProviderHarness, pk: string, type: EventRecordType): JournalEvent {
  const matching = providerEvents(harness, pk).filter((event) => event.record_type === type);
  const [only] = matching;
  if (only === undefined || matching.length !== 1) {
    throw new Error(`found ${String(matching.length)} ${type} event(s) in ${pk}; expected exactly one`);
  }
  return only;
}

/** The ledger items of a partition. */
export function ledgerItems(harness: ProviderHarness, pk: string): readonly StoredItem[] {
  return harness.store.itemsIn('ledger').filter((item) => item.pk === pk);
}

/** The treatment item of a partition. */
export function treatmentItem(harness: ProviderHarness, pk: string): StoredItem | undefined {
  return harness.store.peek('control', { pk, sk: 'treatment' });
}

/** The controller's signal (WP-08), applied directly: `COMMITTED_WAITING -> TIMEOUT_SIGNALLED`. */
export async function signalTimeout(
  harness: ProviderHarness,
  pk: string,
  signalEventId = SIGNAL_EVENT_ID,
): Promise<void> {
  const outcome = await harness.store.write({
    kind: 'update',
    table: 'control',
    key: { pk, sk: 'treatment' },
    set: { state: 'TIMEOUT_SIGNALLED', signal_event_id: signalEventId },
    increment: { version: 1 },
    condition: { kind: 'attribute_equals', name: 'state', value: 'COMMITTED_WAITING' },
  });
  if (outcome.kind !== 'applied') {
    throw new Error(`signal write ${JSON.stringify(outcome)}; expected applied`);
  }
}

/** Cleanup's conditional safety-release request (design §10.4 step 5). */
export async function cleanupRelease(harness: ProviderHarness, pk: string, from: TreatmentState): Promise<void> {
  const outcome = await harness.store.write({
    kind: 'update',
    table: 'control',
    key: { pk, sk: 'treatment' },
    set: { state: 'SAFETY_RELEASED', safety_release_cause: 'CLEANUP_REQUEST' },
    increment: { version: 1 },
    condition: { kind: 'attribute_equals', name: 'state', value: from },
  });
  if (outcome.kind !== 'applied') {
    throw new Error(`cleanup release write ${JSON.stringify(outcome)}; expected applied`);
  }
}

/** The number of TransactWriteItems calls the store saw. */
export function transactionCount(harness: ProviderHarness): number {
  return harness.log.entries().filter((entry) => entry.operation === 'TransactWriteItems').length;
}

/** Reads one property of a JSON object value (test convenience). */
export function field(value: unknown, name: string): JsonValue | undefined {
  return (value as Readonly<Record<string, JsonValue>>)[name];
}
