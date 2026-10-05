// Shared fixtures of the provider-client tests: a ProviderClient on virtual time over named
// fakes (ScriptedProviderInvoker, RecordingAttemptStatePort or the durable attempt-state port,
// a JournalWriter over the caller-journal table of InMemoryItemStore behind a recording port),
// scripted provider responses that echo the generated ids, and a driver that advances virtual
// time until the attempt resolves.

import { setImmediate as nextMacrotask } from 'node:timers/promises';

import type { NodeHttpHandler } from '@smithy/node-http-handler';

import { createDurableJournalPort } from '../../../src/event-journal/durable-journal-port.ts';
import type { JournalEvent } from '../../../src/event-journal/journal-event.ts';
import type { JournalScope } from '../../../src/event-journal/journal-scope.ts';
import { JournalWriter } from '../../../src/event-journal/journal-writer.ts';
import type { AttemptInput } from '../../../src/provider-client/attempt-input.ts';
import type { AttemptReport } from '../../../src/provider-client/attempt-resolution.ts';
import type { AttemptStatePort } from '../../../src/provider-client/attempt-state-port.ts';
import { ATTEMPT_STATE_SK_PREFIX } from '../../../src/provider-client/attempt-state-port.ts';
import { DeadlineTimer } from '../../../src/provider-client/deadline-timer.ts';
import { createDurableAttemptStatePort } from '../../../src/provider-client/durable-attempt-state-port.ts';
import { ProviderClient } from '../../../src/provider-client/provider-client.ts';
import type {
  ProviderResponseSettlement,
  ProviderTransportResult,
} from '../../../src/provider-client/provider-invocation-port.ts';
import type { EventSource } from '../../../src/record-contract/envelope.ts';
import type { JsonValue, Uuid4 } from '../../../src/record-contract/primitives.ts';
import type { ProviderRefundCall } from '../../../src/record-contract/records/group-a/provider_refund_call.ts';
import type { ProviderRejectionReason } from '../../../src/record-contract/records/group-a/provider_refund_response.ts';
import { InMemoryItemStore } from '../durable-store/in-memory-item-store.ts';
import {
  EPOCH_MS,
  INSTANCE_ID,
  MANIFEST_SHA,
  RUN_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  TRIAL_SCOPE,
} from '../event-journal/journal-fixtures.ts';
import { RecordingJournalAppendPort } from '../event-journal/recording-journal-append-port.ts';
import { RecordingMutationLog } from '../kernel/recording-mutation-log.ts';
import { SequentialUuidSource } from '../kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../kernel/virtual-time-scheduler.ts';
import { RecordingAttemptStatePort } from './recording-attempt-state-port.ts';
import type { ScriptedResponder } from './scripted-provider-invoker.ts';
import { ScriptedProviderInvoker } from './scripted-provider-invoker.ts';

export const PROVIDER_QUALIFIER = '7';
export const PROVIDER_CALL_ID = '99999999-0000-4000-8000-000000000001' as Uuid4;
export const PROVIDER_TRANSACTION_ID = '99999999-0000-4000-8000-000000000002' as Uuid4;
/** The ids the client generates for its first attempt (namespace `dddddddd`). */
export const FIRST_ATTEMPT_ID = 'dddddddd-0000-4000-8000-000000000001' as Uuid4;
export const FIRST_PROVIDER_REQUEST_ID = 'dddddddd-0000-4000-8000-000000000002' as Uuid4;
export const CAUSE_EVENT_ID = '11111111-0000-4000-8000-0000000000aa' as Uuid4;
/** An arbitrary source-local monotonic origin: absolute readings must never be serialized. */
export const MONOTONIC_ORIGIN_NS = 987_654_321_000n;
export const MS = 1_000_000n;
const MAX_DRIVE_TURNS = 50;

/** A conventional-caller attempt of the PoC refund (OR-RUA-001 values). */
export function attemptInput(overrides: Partial<AttemptInput> = {}): AttemptInput {
  return {
    caller_id: 'conventional',
    refund_request_id: 'ref-poc-001',
    payment_id: 'pay-poc-001',
    amount_minor: 10000,
    currency: 'BRL',
    provider_qualifier: PROVIDER_QUALIFIER,
    causation_event_ids: [CAUSE_EVENT_ID],
    ...overrides,
  };
}

/** The call the client builds for `attemptInput()` in TRIAL_SCOPE as its first attempt. */
export const PROVIDER_CALL: ProviderRefundCall = {
  caller_id: 'conventional',
  run_id: RUN_ID,
  trial_id: TRIAL_ID,
  trial_manifest_sha256: TRIAL_MANIFEST_SHA,
  schema_version: 1,
  record_type: 'provider_refund_call',
  execution_manifest_sha256: MANIFEST_SHA,
  attempt_id: FIRST_ATTEMPT_ID,
  provider_request_id: FIRST_PROVIDER_REQUEST_ID,
  refund_request_id: 'ref-poc-001',
  payment_id: 'pay-poc-001',
  amount_minor: 10000,
  currency: 'BRL',
};

export interface ClientHarness {
  readonly client: ProviderClient;
  readonly invoker: ScriptedProviderInvoker;
  readonly attempts: AttemptStatePort;
  readonly journal: JournalWriter;
  readonly port: RecordingJournalAppendPort;
  readonly store: InMemoryItemStore;
  readonly time: VirtualTimeScheduler;
}

export interface ClientHarnessOptions {
  readonly scope?: JournalScope;
  readonly source?: EventSource;
  readonly maxDefinitiveRetries?: number;
  /** The attempt-state port; the durable port over the same store by default. */
  readonly attempts?: (store: InMemoryItemStore) => AttemptStatePort;
}

/** A client over the caller-journal table at 2026-10-05T12:00:00.000Z virtual time. */
export function clientHarness(options: ClientHarnessOptions = {}): ClientHarness {
  const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS, monotonicOriginNs: MONOTONIC_ORIGIN_NS });
  const store = new InMemoryItemStore({ clock: time, mutationLog: new RecordingMutationLog() });
  const port = new RecordingJournalAppendPort(createDurableJournalPort(store, 'caller_journal'));
  const scope = options.scope ?? TRIAL_SCOPE;
  const journal = new JournalWriter({
    port,
    source: options.source ?? 'conventional_caller',
    instanceId: INSTANCE_ID,
    scope,
    clock: time,
    ids: new SequentialUuidSource('eeeeeeee'),
    maxDefinitiveRetries: options.maxDefinitiveRetries ?? 0,
  });
  const attempts = (options.attempts ?? createDurableAttemptStatePort)(store);
  const invoker = new ScriptedProviderInvoker(time);
  const client = new ProviderClient({
    invoker,
    attempts,
    journal,
    scope,
    monotonic: time,
    wall: time,
    timer: new DeadlineTimer({ monotonic: time, scheduler: time }),
    ids: new SequentialUuidSource('dddddddd'),
  });
  return { client, invoker, attempts, journal, port, store, time };
}

/** A harness whose attempt-state port is a RecordingAttemptStatePort. */
export function recordingHarness(
  options: Omit<ClientHarnessOptions, 'attempts'> = {},
): ClientHarness & { readonly recorder: RecordingAttemptStatePort } {
  const recorder = new RecordingAttemptStatePort();
  return { ...clientHarness({ ...options, attempts: () => recorder }), recorder };
}

/** Runs one attempt, advancing virtual time whenever it waits, until it resolves or throws. */
export async function settleAttempt(
  harness: ClientHarness,
  input: AttemptInput = attemptInput(),
): Promise<AttemptReport> {
  const progress: { finished: boolean } = { finished: false };
  const pending = harness.client.performAttempt(input).finally(() => {
    progress.finished = true;
  });
  pending.catch(() => undefined);
  for (let turn = 0; turn < MAX_DRIVE_TURNS && !progress.finished; turn += 1) {
    await nextMacrotask();
    await harness.time.advanceUntilIdle();
  }
  if (!progress.finished) {
    throw new Error(`attempt still pending after ${String(MAX_DRIVE_TURNS)} idle turns; expected it to resolve`);
  }
  return pending;
}

/**
 * Every caller-journal event of the harness in source-sequence order: events the journal port
 * stored plus, for a RecordingAttemptStatePort, the events of its applied transactions.
 */
export function journalEvents(harness: ClientHarness): readonly JournalEvent[] {
  const stored = harness.store
    .itemsIn('caller_journal')
    .filter((item) => !item.sk.startsWith(ATTEMPT_STATE_SK_PREFIX))
    .map(({ pk: _pk, sk: _sk, ...event }) => event as unknown as JournalEvent);
  const transactional = harness.attempts instanceof RecordingAttemptStatePort ? harness.attempts.committedEvents() : [];
  return [...stored, ...transactional].sort((a, b) => a.source_sequence - b.source_sequence);
}

/** The single event of `type`; throws when there is none or several. */
export function onlyEvent<T extends JournalEvent['record_type']>(
  events: readonly JournalEvent[],
  type: T,
): Extract<JournalEvent, { readonly record_type: T }> {
  const matching = events.filter((event) => event.record_type === type);
  if (matching.length !== 1) {
    throw new Error(`${String(matching.length)} ${type} event(s); expected exactly one`);
  }
  return matching[0] as Extract<JournalEvent, { readonly record_type: T }>;
}

/** UTF-8 JSON bytes of a payload. */
export function jsonBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** A 200 response from version `executedVersion` carrying `payload`. */
export function invokeResponse(
  payload: Uint8Array,
  executedVersion: string | undefined = PROVIDER_QUALIFIER,
): ProviderResponseSettlement {
  return { kind: 'response', status_code: 200, executed_version: executedVersion, function_error: undefined, payload };
}

/** A provider SUCCEEDED response echoing the call's ids. */
export const succeededResponder: ScriptedResponder = (call) =>
  invokeResponse(
    jsonBytes({
      schema_version: 1,
      record_type: 'provider_refund_response',
      outcome: 'SUCCEEDED',
      provider_call_id: PROVIDER_CALL_ID,
      attempt_id: call.attempt_id,
      provider_request_id: call.provider_request_id,
      provider_transaction_id: PROVIDER_TRANSACTION_ID,
    }),
  );

/** A provider REJECTED response echoing the call's ids. */
export function rejectedResponder(reason: ProviderRejectionReason): ScriptedResponder {
  return (call) =>
    invokeResponse(
      jsonBytes({
        schema_version: 1,
        record_type: 'provider_refund_response',
        outcome: 'REJECTED',
        provider_call_id: PROVIDER_CALL_ID,
        attempt_id: call.attempt_id,
        provider_request_id: call.provider_request_id,
        rejection_reason: reason,
      }),
    );
}

/** A transport error settlement. */
export function transportError(errorName: string, message: string, httpStatus?: number): ProviderTransportResult {
  return httpStatus === undefined
    ? { kind: 'transport_error', error_name: errorName, message }
    : { kind: 'transport_error', error_name: errorName, message, http_status: httpStatus };
}

/** The request type `NodeHttpHandler#handle` takes (the smithy `HttpRequest` class shape). */
export type HandlerHttpRequest = Parameters<NodeHttpHandler['handle']>[0];

/** The wire fields of INVOKE_HTTP_REQUEST, as RecordingHttpHandler records them. */
export const INVOKE_WIRE_FIELDS = {
  method: 'POST',
  path: '/2015-03-31/functions/suc-provider/invocations',
  query: { Qualifier: '7' },
  headers: { 'x-amz-invocation-type': 'RequestResponse' },
  body: new TextEncoder().encode('{}'),
} as const;

/** A raw Invoke request of version 7 of `suc-provider` carrying `body`, for driving HTTP handlers directly. */
export function invokeHttpRequest(body: unknown = INVOKE_WIRE_FIELDS.body): HandlerHttpRequest {
  const request: HandlerHttpRequest = {
    method: INVOKE_WIRE_FIELDS.method,
    protocol: 'https:',
    hostname: 'lambda.us-east-1.amazonaws.com',
    path: INVOKE_WIRE_FIELDS.path,
    query: { ...INVOKE_WIRE_FIELDS.query },
    headers: { ...INVOKE_WIRE_FIELDS.headers },
    body,
    clone: () => request,
  };
  return request;
}
