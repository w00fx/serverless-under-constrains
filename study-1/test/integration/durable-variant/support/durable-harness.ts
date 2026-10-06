// The offline Durable caller: the composed caller over the InMemoryItemStore emulator of the
// caller journal and trial registry and the ScriptedProviderInvoker, on one virtual clock. Step
// tests hand the caller one SQS delivery and one step attempt at a time, as the durable SDK does
// inside the execution's step; the execution tests (`durable-execution-harness.ts`) run the real
// SDK over the same caller. The journal helpers read the store, never the caller.

import assert from 'node:assert/strict';

import type { DurableItemStore } from '../../../../src/durable-store/item-store-port.ts';
import { composeDurableCaller } from '../../../../src/durable-variant/durable-composition.ts';
import type { DurableDeployment } from '../../../../src/durable-variant/durable-environment.ts';
import type {
  DurableInvocation,
  DurableRefundCaller,
  DurableStepResult,
} from '../../../../src/durable-variant/durable-refund-caller.ts';
import type { DurableDelivery } from '../../../../src/durable-variant/durable-sqs-delivery.ts';
import type { JournalEvent } from '../../../../src/event-journal/journal-event.ts';
import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import type { TrialRegistration } from '../../../../src/record-contract/records/group-a/trial_registration.ts';
import { createRecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import { toTrialRegistryItem } from '../../../../src/trial-message/trial-registry.ts';
import { InMemoryItemStore } from '../../../support/durable-store/in-memory-item-store.ts';
import type { ScriptedWriteFault } from '../../../support/durable-store/in-memory-item-store.ts';
import { SequentialUuidSource } from '../../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';
import { PROVIDER_QUALIFIER } from '../../../support/provider-client/provider-client-fixtures.ts';
import { ScriptedProviderInvoker } from '../../../support/provider-client/scripted-provider-invoker.ts';
import {
  EPOCH_MS,
  RUN,
  TRIAL_PK,
  messageBody,
  runRegistration,
} from '../../../unit/trial-message/support/trial-message-fixtures.ts';

/** The durable execution ARN of the step tests (a version-qualified function ARN plus ids). */
export const EXECUTION_ARN =
  'arn:aws:lambda:us-east-1:123456789012:function:suc1-durable-caller:3/durable-execution/exec-0001/run-0001';
export const MESSAGE_ID = 'f5a3c0de-0000-4000-8000-000000000001';
export const TENTH_SECOND_NS = 100_000_000n;
export const DEFINITIVE: ScriptedWriteFault = { kind: 'definitive_failure', code: 'ValidationException' };
export const AMBIGUOUS: ScriptedWriteFault = { kind: 'ambiguous', code: 'TimeoutError', applied: false };

/** The run trial's registration for the Durable variant. */
export function durableRegistration(overrides: Partial<TrialRegistration> = {}): TrialRegistration {
  return runRegistration({ variant_id: 'durable', ...overrides });
}

/** What the journal helpers read: the emulated store of the caller journal. */
export interface JournalView {
  readonly store: InMemoryItemStore;
}

export interface DurableHarness extends JournalView {
  readonly time: VirtualTimeScheduler;
  readonly invoker: ScriptedProviderInvoker;
  readonly caller: DurableRefundCaller;
}

export interface DurableHarnessOptions {
  readonly deployment?: DurableDeployment;
  /** The provider version the caller targets; a misconfigured one reaches the provider client. */
  readonly providerQualifier?: string;
  /** The registry item to seed; `null` seeds none. */
  readonly registration?: TrialRegistration | null;
  /** Wraps the store the caller sees, to interleave or fault its operations. */
  readonly wrapStore?: (store: InMemoryItemStore) => DurableItemStore;
}

/** A Durable caller at 2026-10-05T12:00:00.000Z virtual time, with the durable run trial registered. */
export function durableHarness(options: DurableHarnessOptions = {}): DurableHarness {
  const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS, monotonicOriginNs: 1_000_000_000n });
  const store = new InMemoryItemStore({ clock: time });
  const registration = options.registration === undefined ? durableRegistration() : options.registration;
  if (registration !== null) {
    store.seed('trial_registry', toTrialRegistryItem(registration));
  }
  const invoker = new ScriptedProviderInvoker(time);
  const caller = composeDurableCaller({
    deployment: options.deployment ?? (RUN as DurableDeployment),
    provider_qualifier: options.providerQualifier ?? PROVIDER_QUALIFIER,
    store: options.wrapStore === undefined ? store : options.wrapStore(store),
    invoker,
    ids: new SequentialUuidSource('dddddddd'),
    wall: time,
    monotonic: time,
    scheduler: time,
  });
  return { time, store, invoker, caller };
}

/** One SQS delivery of the run trial's message (receive 1 unless overridden). */
export function durableDelivery(overrides: Partial<DurableDelivery> = {}): DurableDelivery {
  return { message_id: MESSAGE_ID, approximate_receive_count: 1, body: messageBody(), ...overrides };
}

/** The invocation of step attempt `stepAttempt`, in a Lambda request named after it. */
export function invocationOf(stepAttempt: number, lambdaRequestId?: string): DurableInvocation {
  return {
    lambda_request_id: lambdaRequestId ?? `lambda-request-step-${String(stepAttempt)}`,
    durable_execution_arn: EXECUTION_ARN,
    step_attempt: stepAttempt,
  };
}

/** Runs `pending` to completion on virtual time. */
export async function settle<T>(time: VirtualTimeScheduler, pending: Promise<T>): Promise<T> {
  // A holder, not a local: the flag is set in a callback control-flow analysis cannot see.
  const progress = { done: false };
  const tracked = pending.finally(() => {
    progress.done = true;
  });
  tracked.catch(() => undefined);
  for (let turn = 0; turn < 200 && !progress.done; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await time.advanceUntilIdle();
  }
  return tracked;
}

/** Runs one step attempt over `delivery` on virtual time. */
export function runStep(
  harness: DurableHarness,
  delivery: DurableDelivery,
  invocation: DurableInvocation,
): Promise<DurableStepResult> {
  return settle(harness.time, harness.caller.runStepAttempt(delivery, invocation));
}

/** Runs one step attempt that must throw, and returns what it threw. */
export async function failedStep(
  harness: DurableHarness,
  delivery: DurableDelivery,
  invocation: DurableInvocation,
): Promise<unknown> {
  try {
    const result = await runStep(harness, delivery, invocation);
    assert.fail(
      `step attempt ${String(invocation.step_attempt)} completed with ${JSON.stringify(result)}; expected a throw`,
    );
  } catch (error: unknown) {
    return error;
  }
}

/** Scripts `faults` on the next caller-journal writes once an event of `recordType` is committed. */
export function faultAfterEvent(view: JournalView, recordType: string, faults: readonly ScriptedWriteFault[]): void {
  const stop = view.store.subscribe('caller_journal', (change) => {
    if (change.new_image['record_type'] !== recordType) {
      return;
    }
    stop();
    for (const fault of faults) {
      view.store.scriptWriteFault(fault, { table: 'caller_journal' });
    }
  });
}

/** The caller events of the run trial's partition, in sort-key order. */
export function callerEvents(view: JournalView, pk: string = TRIAL_PK): readonly JournalEvent[] {
  return view.store
    .itemsIn('caller_journal')
    .filter((item) => item.pk === pk && !item.sk.startsWith('state#'))
    .map(({ pk: _pk, sk: _sk, ...event }) => event as unknown as JournalEvent);
}

/** The record types of the run trial's caller events, ordered by occurrence then source sequence. */
export function recordTypes(view: JournalView): readonly string[] {
  return ordered(callerEvents(view)).map((event) => event.record_type);
}

/** The events of one record type, ordered by occurrence then source sequence. */
export function eventsOfType<T extends JournalEvent['record_type']>(
  view: JournalView,
  type: T,
): readonly Extract<JournalEvent, { readonly record_type: T }>[] {
  return ordered(callerEvents(view)).filter(
    (event): event is Extract<JournalEvent, { readonly record_type: T }> => event.record_type === type,
  );
}

function ordered(events: readonly JournalEvent[]): readonly JournalEvent[] {
  return events.toSorted(
    (a, b) =>
      a.occurred_at.localeCompare(b.occurred_at) ||
      a.source_instance_id.localeCompare(b.source_instance_id) ||
      a.source_sequence - b.source_sequence,
  );
}

/** One recorded request state, reduced to the fields BR-RUA-004 reads. */
export interface RecordedRequestState {
  readonly version: number;
  readonly processing_state: string;
  readonly processing_terminal_reason: string | undefined;
  readonly effect_knowledge: string;
  readonly attempt_ids: readonly string[];
}

/** The recorded request states in version order. */
export function requestStates(view: JournalView): readonly RecordedRequestState[] {
  return eventsOfType(view, 'request_state_recorded')
    .toSorted((a, b) => a.version - b.version)
    .map((state) => ({
      version: state.version,
      processing_state: state.processing_state,
      processing_terminal_reason: 'processing_terminal_reason' in state ? state.processing_terminal_reason : undefined,
      effect_knowledge: state.effect_knowledge,
      attempt_ids: [...state.attempt_ids],
    }));
}

const validator = createRecordValidator();

/** Fails unless every caller event of the trial conforms to its record schema (AC-RUA-046). */
export function assertEventsConform(view: JournalView): void {
  for (const event of callerEvents(view)) {
    const checked = validator.validate(event as unknown as JsonValue);
    assert.ok(checked.valid, JSON.stringify(checked));
  }
}
