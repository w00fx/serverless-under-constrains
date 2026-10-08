// Shared fixtures of the event-journal tests: fixed identities, one scope per partition kind,
// typed event bodies, and a writer harness on virtual time over a journal table
// (InMemoryItemStore) or a JSONL file (MemoryAppendOnlyFile), behind a recording port.

import { createDurableJournalPort } from '../../../src/event-journal/durable-journal-port.ts';
import type { ConfirmResult } from '../../../src/event-journal/journal-append-port.ts';
import type { JournalEvent } from '../../../src/event-journal/journal-event.ts';
import type { EventBody } from '../../../src/event-journal/journal-event.ts';
import type { JournalScope } from '../../../src/event-journal/journal-scope.ts';
import { JournalWriter } from '../../../src/event-journal/journal-writer.ts';
import { createJsonlJournalPort } from '../../../src/event-journal/jsonl-journal-port.ts';
import type { EventSource } from '../../../src/record-contract/envelope.ts';
import type { ExecutionIdentity, Sha256Hex, Uuid4, UtcMillis } from '../../../src/record-contract/primitives.ts';
import { RecordingMutationLog } from '../kernel/recording-mutation-log.ts';
import { SequentialUuidSource } from '../kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../kernel/virtual-time-scheduler.ts';
import { InMemoryItemStore } from '../durable-store/in-memory-item-store.ts';
import { MemoryAppendOnlyFile } from './memory-append-only-file.ts';
import { RecordingJournalAppendPort } from './recording-journal-append-port.ts';

export const RUN_ID = 'aaaaaaaa-0000-4000-8000-000000000001' as Uuid4;
export const PROBE_ID = 'aaaaaaaa-0000-4000-8000-000000000002' as Uuid4;
export const VALIDATION_ID = 'aaaaaaaa-0000-4000-8000-000000000003' as Uuid4;
export const TRIAL_ID = 'bbbbbbbb-0000-4000-8000-000000000001' as Uuid4;
export const INSTANCE_ID = 'cccccccc-0000-4000-8000-000000000001' as Uuid4;
export const ATTEMPT_ID = 'dddddddd-0000-4000-8000-000000000001' as Uuid4;
export const PROVIDER_REQUEST_ID = 'dddddddd-0000-4000-8000-000000000002' as Uuid4;
export const CAUSE_LOW = '11111111-0000-4000-8000-000000000001' as Uuid4;
export const CAUSE_HIGH = '11111111-0000-4000-8000-000000000002' as Uuid4;
export const MANIFEST_SHA = 'a'.repeat(64) as Sha256Hex;
export const TRIAL_MANIFEST_SHA = 'b'.repeat(64) as Sha256Hex;
export const EPOCH_MS = Date.UTC(2026, 9, 5, 12, 0, 0, 0);
export const EPOCH_UTC = '2026-10-05T12:00:00.000Z' as UtcMillis;
export const JSONL_PATH = 'runner/runner-journal.jsonl';

export const RUN: ExecutionIdentity = { execution_kind: 'RUN', run_id: RUN_ID };
export const PROBE: ExecutionIdentity = { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: PROBE_ID };
export const VALIDATION: ExecutionIdentity = {
  execution_kind: 'VARIANT_VALIDATION',
  variant_validation_id: VALIDATION_ID,
};

export const TRIAL_SCOPE: JournalScope = {
  execution: RUN,
  execution_manifest_sha256: MANIFEST_SHA,
  partition: { kind: 'trial', trial_id: TRIAL_ID, trial_manifest_sha256: TRIAL_MANIFEST_SHA },
};

/** A scope of `execution` whose partition has no trial. */
export function executionLevelScope(
  execution: ExecutionIdentity,
  kind: 'probe' | 'canary' | 'warmup' | 'provider' | 'execution',
): JournalScope {
  return { execution, execution_manifest_sha256: MANIFEST_SHA, partition: { kind } };
}

/** A `dispatch_started` body; `n` varies the business identity so bodies differ. */
export function dispatchStartedBody(n = 1): EventBody<'dispatch_started'> {
  return {
    attempt_id: ATTEMPT_ID,
    provider_request_id: PROVIDER_REQUEST_ID,
    refund_request_id: `ref-poc-${String(n).padStart(3, '0')}`,
    dispatch_at: EPOCH_UTC,
    deadline_at: '2026-10-05T12:00:03.000Z' as UtcMillis,
    deadline_ns: '3000000000' as EventBody<'dispatch_started'>['deadline_ns'],
  };
}

export interface WriterHarness {
  readonly writer: JournalWriter;
  readonly port: RecordingJournalAppendPort;
  readonly store: InMemoryItemStore;
  readonly file: MemoryAppendOnlyFile;
  readonly time: VirtualTimeScheduler;
  readonly log: RecordingMutationLog;
  readonly ids: SequentialUuidSource;
}

export interface WriterHarnessOptions {
  readonly medium?: 'table' | 'jsonl';
  readonly scope?: JournalScope;
  readonly source?: EventSource;
  readonly maxDefinitiveRetries?: number;
}

/** A writer at 2026-10-05T12:00:00.000Z virtual time, by default over the caller-journal table. */
export function writerHarness(options: WriterHarnessOptions = {}): WriterHarness {
  const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS });
  const log = new RecordingMutationLog();
  const store = new InMemoryItemStore({ clock: time, mutationLog: log });
  const file = new MemoryAppendOnlyFile();
  const inner =
    options.medium === 'jsonl'
      ? createJsonlJournalPort(JSONL_PATH, file)
      : createDurableJournalPort(store, 'caller_journal');
  const port = new RecordingJournalAppendPort(inner);
  const ids = new SequentialUuidSource('eeeeeeee');
  const writer = new JournalWriter({
    port,
    source: options.source ?? 'conventional_caller',
    instanceId: INSTANCE_ID,
    scope: options.scope ?? TRIAL_SCOPE,
    clock: time,
    ids,
    maxDefinitiveRetries: options.maxDefinitiveRetries ?? 2,
  });
  return { writer, port, store, file, time, log, ids };
}

/** The event of an `appended` result; any other result fails the test with its content. */
export function appendedEvent(result: ConfirmResult): JournalEvent {
  if (result.kind !== 'appended') {
    throw new Error(`journal result ${JSON.stringify(result)}; expected kind 'appended'`);
  }
  return result.event;
}

/** The `refund_request_id` an event carries, or `undefined` for record types without one. */
export function refundRequestIdOf(event: JournalEvent): string | undefined {
  return 'refund_request_id' in event ? event.refund_request_id : undefined;
}
