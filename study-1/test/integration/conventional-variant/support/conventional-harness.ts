// The offline conventional variant: the composed consumer over the InMemoryItemStore emulator of
// the caller journal and trial registry, the ScriptedProviderInvoker, and the FIFO source with
// its DLQ driven by the fake event source mapping, all on one virtual clock. Tests publish the
// trial message as the runner does (`MessageGroupId = MessageDeduplicationId = trial_id`) and
// poll the mapping, advancing virtual time past the 60 s visibility timeout between receives.

import assert from 'node:assert/strict';

import { composeConventionalConsumer } from '../../../../src/conventional-variant/conventional-composition.ts';
import type { ConventionalRefundConsumer } from '../../../../src/conventional-variant/conventional-consumer.ts';
import type { VariantDeployment } from '../../../../src/conventional-variant/conventional-environment.ts';
import { consumeSqsEvent } from '../../../../src/conventional-variant/sqs-event-consumption.ts';
import type { DurableItemStore } from '../../../../src/durable-store/item-store-port.ts';
import type { JournalEvent } from '../../../../src/event-journal/journal-event.ts';
import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import type { TrialRegistration } from '../../../../src/record-contract/records/group-a/trial_registration.ts';
import { createRecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import { toTrialRegistryItem } from '../../../../src/trial-message/trial-registry.ts';
import { InMemoryItemStore } from '../../../support/durable-store/in-memory-item-store.ts';
import { FakeSqsEsmDriver } from '../../../support/fifo-queue/fake-sqs-esm-driver.ts';
import type { PollResult } from '../../../support/fifo-queue/fake-sqs-esm-driver.ts';
import { InMemoryFifoQueue } from '../../../support/fifo-queue/in-memory-fifo-queue.ts';
import { SequentialUuidSource } from '../../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';
import { PROVIDER_QUALIFIER } from '../../../support/provider-client/provider-client-fixtures.ts';
import { ScriptedProviderInvoker } from '../../../support/provider-client/scripted-provider-invoker.ts';
import {
  EPOCH_MS,
  RUN,
  TRIAL_ID,
  TRIAL_PK,
  messageBody,
  runRegistration,
} from '../../../unit/trial-message/support/trial-message-fixtures.ts';

/** OR-RUA-002: the conventional source's visibility timeout. */
export const VISIBILITY_TIMEOUT_MS = 60_000;
export const SOURCE_ARN = 'arn:aws:sqs:us-east-1:123456789012:suc1-aaaaaaaa-conventional-source.fifo';

export interface ConventionalHarness {
  readonly time: VirtualTimeScheduler;
  readonly store: InMemoryItemStore;
  readonly invoker: ScriptedProviderInvoker;
  readonly consumer: ConventionalRefundConsumer;
  readonly source: InMemoryFifoQueue;
  readonly dlq: InMemoryFifoQueue;
  readonly driver: FakeSqsEsmDriver;
}

export interface HarnessOptions {
  readonly deployment?: VariantDeployment;
  /** The provider version the consumer targets; a misconfigured one reaches the provider client. */
  readonly providerQualifier?: string;
  /** The registry item to seed; `null` seeds none. */
  readonly registration?: TrialRegistration | null;
  /** Wraps the store the consumer sees, to interleave or fault its operations. */
  readonly wrapStore?: (store: InMemoryItemStore) => DurableItemStore;
}

/** A conventional variant at 2026-10-05T12:00:00.000Z virtual time, with the run trial registered. */
export function conventionalHarness(options: HarnessOptions = {}): ConventionalHarness {
  const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS, monotonicOriginNs: 1_000_000_000n });
  const store = new InMemoryItemStore({ clock: time });
  const registration = options.registration === undefined ? runRegistration() : options.registration;
  if (registration !== null) {
    store.seed('trial_registry', toTrialRegistryItem(registration));
  }
  const invoker = new ScriptedProviderInvoker(time);
  const consumer = composeConventionalConsumer({
    deployment: options.deployment ?? (RUN as VariantDeployment),
    provider_qualifier: options.providerQualifier ?? PROVIDER_QUALIFIER,
    store: options.wrapStore === undefined ? store : options.wrapStore(store),
    invoker,
    ids: new SequentialUuidSource('dddddddd'),
    wall: time,
    monotonic: time,
    scheduler: time,
  });
  const queueIds = new SequentialUuidSource('99999999');
  const dlq = new InMemoryFifoQueue({ clock: time, ids: queueIds, visibilityTimeoutMs: VISIBILITY_TIMEOUT_MS });
  const source = new InMemoryFifoQueue({
    clock: time,
    ids: queueIds,
    visibilityTimeoutMs: VISIBILITY_TIMEOUT_MS,
    redrive: { maxReceiveCount: 2, deadLetterQueue: dlq },
  });
  const driver = new FakeSqsEsmDriver({
    queue: source,
    invoke: (event, context): Promise<void> => consumeSqsEvent(consumer, event, context.awsRequestId),
    event_source_arn: SOURCE_ARN,
  });
  return { time, store, invoker, consumer, source, dlq, driver };
}

/** Publishes a body as the runner does; returns the SQS message id. */
export function publish(harness: ConventionalHarness, body: string = messageBody()): string {
  return harness.source.send({ body, message_group_id: TRIAL_ID, message_deduplication_id: TRIAL_ID }).message_id;
}

/** Runs `pending` to completion on virtual time. */
export async function settle<T>(harness: ConventionalHarness, pending: Promise<T>): Promise<T> {
  // A holder, not a local: the flag is set in a callback control-flow analysis cannot see.
  const progress = { done: false };
  const tracked = pending.finally(() => {
    progress.done = true;
  });
  tracked.catch(() => undefined);
  for (let turn = 0; turn < 200 && !progress.done; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.time.advanceUntilIdle();
  }
  return tracked;
}

/** One poll of the mapping, settled on virtual time. */
export function poll(harness: ConventionalHarness): Promise<PollResult> {
  return settle(harness, harness.driver.pollOnce());
}

/** Lets the visibility timeout of an in-flight message expire. */
export async function waitOutVisibility(harness: ConventionalHarness): Promise<void> {
  await harness.time.advanceBy(VISIBILITY_TIMEOUT_MS);
}

/** The caller events of the run trial's partition, in sort-key order. */
export function callerEvents(harness: ConventionalHarness): readonly JournalEvent[] {
  return harness.store
    .itemsIn('caller_journal')
    .filter((item) => item.pk === TRIAL_PK && !item.sk.startsWith('state#'))
    .map(({ pk: _pk, sk: _sk, ...event }) => event as unknown as JournalEvent);
}

/** The events of one record type, ordered by occurrence then source sequence. */
export function eventsOfType<T extends JournalEvent['record_type']>(
  harness: ConventionalHarness,
  type: T,
): readonly Extract<JournalEvent, { readonly record_type: T }>[] {
  return callerEvents(harness)
    .filter((event): event is Extract<JournalEvent, { readonly record_type: T }> => event.record_type === type)
    .toSorted((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.source_sequence - b.source_sequence);
}

/** One recorded request state, reduced to the fields BR-RUA-004 reads. */
export interface RecordedRequestState {
  readonly version: number;
  readonly processing_state: string;
  readonly processing_terminal_reason: string | undefined;
  readonly effect_knowledge: string;
  readonly attempt_ids: readonly string[];
  readonly refund_request_id: string | undefined;
}

/** The recorded request states in version order. */
export function requestStates(harness: ConventionalHarness): readonly RecordedRequestState[] {
  return eventsOfType(harness, 'request_state_recorded')
    .toSorted((a, b) => a.version - b.version)
    .map((state) => ({
      version: state.version,
      processing_state: state.processing_state,
      processing_terminal_reason: 'processing_terminal_reason' in state ? state.processing_terminal_reason : undefined,
      effect_knowledge: state.effect_knowledge,
      attempt_ids: [...state.attempt_ids],
      refund_request_id: state.refund_request_id,
    }));
}

const validator = createRecordValidator();

/** Fails unless every caller event of the trial conforms to its record schema (AC-RUA-046). */
export function assertEventsConform(harness: ConventionalHarness): void {
  for (const event of callerEvents(harness)) {
    const checked = validator.validate(event as unknown as JsonValue);
    assert.ok(checked.valid, JSON.stringify(checked));
  }
}
