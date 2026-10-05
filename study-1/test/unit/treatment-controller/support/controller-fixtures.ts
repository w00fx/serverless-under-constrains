// Shared fixtures of the treatment-controller tests: caller timeout images as the caller
// journal stores them (design §9.3), the treatment items each §9.11 row reads, and a harness that
// composes the real controller over the InMemoryItemStore emulator (WP-04). The control items
// the runner writes come from the refund-provider fixtures, so both features read the same
// configuration, payment and armed treatment.

import type { StoredItem } from '../../../../src/durable-store/item-store-port.ts';
import type { JournalEvent } from '../../../../src/event-journal/journal-event.ts';
import { createRecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import type { ExecutionIdentity, JsonObject, Uuid4 } from '../../../../src/record-contract/primitives.ts';
import type { SignalledTreatmentState } from '../../../../src/record-contract/records/group-b/vocabulary.ts';
import { composeTreatmentController } from '../../../../src/treatment-controller/controller-composition.ts';
import type { StreamInsertRecord } from '../../../../src/treatment-controller/stream-record.ts';
import type { TreatmentController } from '../../../../src/treatment-controller/treatment-controller.ts';
import { InMemoryItemStore } from '../../../support/durable-store/in-memory-item-store.ts';
import { RecordingMutationLog } from '../../../support/kernel/recording-mutation-log.ts';
import { SequentialUuidSource } from '../../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';
import {
  ATTEMPT_ID,
  EPOCH_MS,
  MANIFEST_SHA,
  PROBE_ID,
  PROBE_PK,
  PROVIDER_REQUEST_ID,
  REFUND_REQUEST_ID,
  RUN,
  RUN_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  TRIAL_PK,
} from '../../refund-provider/support/provider-fixtures.ts';

export {
  ATTEMPT_ID,
  MANIFEST_SHA,
  OTHER_SHA,
  OTHER_TRIAL_ID,
  PROBE,
  PROBE_ID,
  PROBE_PK,
  RUN,
  RUN_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  TRIAL_PK,
  VALIDATION,
  VALIDATION_ID,
  OTHER_RUN_ID,
  armedTreatmentItem,
  probeConfigItem,
  trialConfigItem,
} from '../../refund-provider/support/provider-fixtures.ts';

export const CALLER_EVENT_ID = 'cafe0000-0000-4000-8000-000000000001' as Uuid4;
export const OTHER_CALLER_EVENT_ID = 'cafe0000-0000-4000-8000-000000000002' as Uuid4;
export const OTHER_ATTEMPT_ID = 'dddddddd-0000-4000-8000-0000000000ff' as Uuid4;
export const DISPATCH_EVENT_ID = 'cafe0000-0000-4000-8000-000000000003' as Uuid4;
export const CALLER_INSTANCE_ID = 'cafe0000-0000-4000-8000-000000000004' as Uuid4;
// Sorts after CALLER_EVENT_ID, so a sorted signal causation is [caller event, commit event].
export const COMMIT_EVENT_ID = 'f0000000-0000-4000-8000-000000000001' as Uuid4;
export const PROVIDER_COMMIT_ID = 'f0000000-0000-4000-8000-000000000002' as Uuid4;
export const CANARY_PK = `${PROBE_ID}#canary`;
export const RUN_CANARY_PK = `${RUN_ID}#canary`;

type ImagePartition = 'trial' | 'probe' | 'canary';

/** A valid `caller_timeout_recorded` as stored in the caller journal (pk/sk included). */
export function callerTimeoutImage(partition: ImagePartition, overrides: JsonObject = {}): StoredItem {
  const source = partition === 'canary' ? 'runner' : partition === 'trial' ? 'conventional_caller' : 'probe_caller';
  const identity = partition === 'trial' ? { run_id: RUN_ID } : { transport_probe_id: PROBE_ID };
  const trial = partition === 'trial' ? { trial_id: TRIAL_ID, trial_manifest_sha256: TRIAL_MANIFEST_SHA } : {};
  const pk = partition === 'trial' ? TRIAL_PK : partition === 'probe' ? PROBE_PK : CANARY_PK;
  return {
    pk,
    sk: `${source}#${CALLER_INSTANCE_ID}#000000000004`,
    schema_version: 1,
    record_type: 'caller_timeout_recorded',
    event_id: CALLER_EVENT_ID,
    ...identity,
    execution_manifest_sha256: MANIFEST_SHA,
    ...trial,
    occurred_at: '2026-10-05T12:00:03.000Z',
    source,
    source_instance_id: CALLER_INSTANCE_ID,
    source_sequence: 4,
    causation_event_ids: [DISPATCH_EVENT_ID],
    attempt_id: ATTEMPT_ID,
    provider_request_id: PROVIDER_REQUEST_ID,
    refund_request_id: REFUND_REQUEST_ID,
    elapsed_ns: '3000000000',
    monotonic_origin_event_id: DISPATCH_EVENT_ID,
    dispatch_at: '2026-10-05T12:00:00.000Z',
    deadline_at: '2026-10-05T12:00:03.000Z',
    timer_fired_at: '2026-10-05T12:00:03.000Z',
    abort_requested_at: '2026-10-05T12:00:03.000Z',
    recorded_at: '2026-10-05T12:00:03.000Z',
    arbiter_winner: 'TIMER',
    transport_settled_at_claim: false,
    ...overrides,
  };
}

/** The treatment after the targeted commit: COMMITTED_WAITING on ATTEMPT_ID. */
export function committedTreatmentItem(pk: string, overrides: JsonObject = {}): StoredItem {
  return {
    pk,
    sk: 'treatment',
    state: 'COMMITTED_WAITING',
    version: 2,
    targeted_attempt_id: ATTEMPT_ID,
    provider_request_id: PROVIDER_REQUEST_ID,
    provider_call_id: 'f0000000-0000-4000-8000-000000000003',
    provider_commit_id: PROVIDER_COMMIT_ID,
    provider_transaction_id: 'f0000000-0000-4000-8000-000000000004',
    commit_event_id: COMMIT_EVENT_ID,
    ...overrides,
  };
}

/** A signalled treatment whose signal came from `signalCaller`. */
export function signalledTreatmentItem(
  pk: string,
  state: SignalledTreatmentState,
  signalCaller: Uuid4 = CALLER_EVENT_ID,
): StoredItem {
  return committedTreatmentItem(pk, {
    state,
    version: 3,
    signal_event_id: 'f0000000-0000-4000-8000-000000000005',
    signal_caller_event_id: signalCaller,
  });
}

/** One stream record as `unmarshallStreamRecord` returns it. */
export function streamInsert(image: StoredItem, eventName = 'INSERT', sequenceNumber = '1'): StreamInsertRecord {
  return { event_name: eventName, new_image: image, sequence_number: sequenceNumber };
}

export interface ControllerHarness {
  readonly store: InMemoryItemStore;
  readonly time: VirtualTimeScheduler;
  readonly log: RecordingMutationLog;
  readonly controller: TreatmentController;
}

/** The real controller over an empty InMemoryItemStore on virtual time. */
export function controllerHarness(deployment: ExecutionIdentity = RUN): ControllerHarness {
  const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS + 3_000 });
  const log = new RecordingMutationLog();
  const store = new InMemoryItemStore({ clock: time, mutationLog: log });
  const controller = composeTreatmentController({
    deployment,
    store,
    ids: new SequentialUuidSource('cccccccc'),
    wall: time,
  });
  return { store, time, log, controller };
}

/** The controller events of a partition, in journal order. */
export function controllerEvents(harness: ControllerHarness, pk: string): readonly JournalEvent[] {
  return harness.store
    .itemsIn('experiment_journal')
    .filter((item) => item.pk === pk)
    .map((item) => {
      const { pk: _pk, sk: _sk, ...event } = item;
      return event as unknown as JournalEvent;
    });
}

/** The single controller event of a partition; throws unless there is exactly one. */
export function onlyControllerEvent(harness: ControllerHarness, pk: string): JournalEvent {
  const events = controllerEvents(harness, pk);
  const [only] = events;
  if (only === undefined || events.length !== 1) {
    throw new Error(`found ${String(events.length)} controller event(s) in ${pk}; expected exactly one`);
  }
  return only;
}

const validator = createRecordValidator();

/** Throws unless every record passes its catalogue schema (Ajv, the oracle's validator). */
export function assertSchemaValid(records: readonly JsonObject[]): void {
  for (const record of records) {
    const checked = validator.validate(record);
    if (!checked.valid) {
      throw new Error(
        `${JSON.stringify(record['record_type'])} violates its schema: ${JSON.stringify(checked.violations)}`,
      );
    }
  }
}
