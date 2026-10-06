// Shared fixtures of the coordination-lease tests: fixed owners, a lease item builder, and a
// harness that wires the real LeaseSession and LeaseHeartbeatLoop to the coordination-store
// emulation, a real JournalWriter over a JSONL coordination journal (MemoryAppendOnlyFile)
// and one virtual time base.

import { LeaseHeartbeatLoop } from '../../../src/coordination-lease/lease-heartbeat-loop.ts';
import type { LeaseItem, LeaseOwner } from '../../../src/coordination-lease/lease-item.ts';
import { acquiredLeaseItem, toStoredItem } from '../../../src/coordination-lease/lease-item.ts';
import { LeaseSession } from '../../../src/coordination-lease/lease-session.ts';
import { JournalWriter } from '../../../src/event-journal/journal-writer.ts';
import { createJsonlJournalPort } from '../../../src/event-journal/jsonl-journal-port.ts';
import { parseJsonl } from '../../../src/record-contract/parsing.ts';
import type {
  ExecutionIdentity,
  JsonValue,
  Sha256Hex,
  Uuid4,
  UtcMillis,
} from '../../../src/record-contract/primitives.ts';
import type { LeaseEventRecorded } from '../../../src/record-contract/records/group-b/lease_event_recorded.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import type { StoredItem } from '../../../src/durable-store/item-store-port.ts';
import { MemoryAppendOnlyFile } from '../event-journal/memory-append-only-file.ts';
import { RecordingMutationLog } from '../kernel/recording-mutation-log.ts';
import { SequentialUuidSource } from '../kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../kernel/virtual-time-scheduler.ts';
import { FakeLeaseStore } from './fake-lease-store.ts';
import { RecordingLeaseLossListener } from './recording-lease-loss-listener.ts';

export const RUN_ID = '3f1c2a9e-8b4d-4c1e-9f00-1a2b3c4d5e6f' as Uuid4;
export const FOREIGN_PROBE_ID = '7d2e4f60-1a2b-4c3d-8e4f-5a6b7c8d9e0f' as Uuid4;
export const RUN_MANIFEST_SHA = 'a1'.repeat(32) as Sha256Hex;
export const OTHER_MANIFEST_SHA = 'b2'.repeat(32) as Sha256Hex;
export const EPOCH_MS = Date.UTC(2026, 9, 5, 12, 0, 0, 0);
export const EPOCH_UTC = '2026-10-05T12:00:00.000Z' as UtcMillis;
export const COORDINATION_JOURNAL_PATH = 'coordination/coordination-journal.jsonl';
export const LEASE_INSTANCE_ID = 'c0c0c0c0-0000-4000-8000-000000000001' as Uuid4;

export const RUN_EXECUTION: ExecutionIdentity = { execution_kind: 'RUN', run_id: RUN_ID };
export const RUN_OWNER: LeaseOwner = { owner_kind: 'RUN', owner_id: RUN_ID, owner_manifest_sha256: RUN_MANIFEST_SHA };
export const FOREIGN_OWNER: LeaseOwner = {
  owner_kind: 'TRANSPORT_PROBE',
  owner_id: FOREIGN_PROBE_ID,
  owner_manifest_sha256: OTHER_MANIFEST_SHA,
};

/**
 * A valid lease item of `owner` acquired at `at`, with `changes` applied.
 *
 * @example
 * leaseItem(FOREIGN_OWNER, EPOCH_UTC, { lease_status: 'RELEASED', lease_version: 4 });
 */
export function leaseItem(owner: LeaseOwner, at: UtcMillis, changes: Partial<LeaseItem> = {}): LeaseItem {
  return { ...acquiredLeaseItem(owner, at), ...changes };
}

/** The stored form of `leaseItem`. */
export function storedLeaseItem(owner: LeaseOwner, at: UtcMillis, changes: Partial<LeaseItem> = {}): StoredItem {
  return toStoredItem(leaseItem(owner, at, changes));
}

export interface LeaseHarness {
  readonly time: VirtualTimeScheduler;
  readonly store: FakeLeaseStore;
  readonly file: MemoryAppendOnlyFile;
  readonly journal: JournalWriter;
  readonly session: LeaseSession;
  readonly listener: RecordingLeaseLossListener;
  readonly loop: LeaseHeartbeatLoop;
  readonly log: RecordingMutationLog;
}

/**
 * The lease of RUN_OWNER at 2026-10-05T12:00:00.000Z virtual time, with its heartbeat loop
 * (not started) and a coordination journal in memory.
 *
 * @example
 * const lease = leaseHarness();
 * await lease.session.acquire(RUN_OWNER);
 * lease.loop.start();
 * await lease.time.advanceBy(30_000); // one heartbeat
 */
export function leaseHarness(): LeaseHarness {
  const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS });
  const log = new RecordingMutationLog();
  const store = new FakeLeaseStore({ clock: time, mutationLog: log });
  const file = new MemoryAppendOnlyFile();
  const journal = new JournalWriter({
    port: createJsonlJournalPort(COORDINATION_JOURNAL_PATH, file),
    source: 'coordination_lease',
    instanceId: LEASE_INSTANCE_ID,
    scope: { execution: RUN_EXECUTION, execution_manifest_sha256: RUN_MANIFEST_SHA, partition: { kind: 'execution' } },
    clock: time,
    ids: new SequentialUuidSource('e1e1e1e1'),
    maxDefinitiveRetries: 2,
  });
  const session = new LeaseSession({
    store,
    monotonic: time,
    wall: time,
    journal,
    heartbeatIntervalMs: 30_000,
    staleBoundaryMs: 300_000,
  });
  const listener = new RecordingLeaseLossListener(time);
  const loop = new LeaseHeartbeatLoop({ session, scheduler: time, listener });
  return { time, store, file, journal, session, listener, loop, log };
}

/**
 * The lease events of the coordination journal, in line order. Throws an Error naming the line
 * when a line is not a JSON object.
 *
 * @example
 * leaseEvents(harness).map((event) => event.lease_event); // ['ACQUIRED', 'HEARTBEAT_CONFIRMED']
 */
export function leaseEvents(harness: Pick<LeaseHarness, 'file'>): readonly LeaseEventRecorded[] {
  const bytes = harness.file.contents(COORDINATION_JOURNAL_PATH) ?? new Uint8Array(0);
  return parseJsonl(bytes).lines.map((line) => {
    if (!line.parsed.ok || typeof line.parsed.value !== 'object' || line.parsed.value === null) {
      throw new Error(
        `coordination journal line ${String(line.line_number)} is not a JSON object; expected a lease event`,
      );
    }
    return line.parsed.value as unknown as LeaseEventRecorded;
  });
}

/**
 * The `lease_event` values of the coordination journal, in order.
 *
 * @example
 * leaseEventNames(harness); // ['ACQUIRED', 'HEARTBEAT_FAILED', 'RECOVERED']
 */
export function leaseEventNames(harness: Pick<LeaseHarness, 'file'>): readonly string[] {
  return leaseEvents(harness).map((event) => event.lease_event);
}

/**
 * The coordination journal lines that the catalogue schemas refuse, each with its violations;
 * empty when every line is a valid `lease_event_recorded` record.
 *
 * @example
 * assert.deepEqual(invalidLeaseEvents(harness), []);
 */
export function invalidLeaseEvents(harness: Pick<LeaseHarness, 'file'>): readonly string[] {
  const validator = createRecordValidator();
  return leaseEvents(harness).flatMap((event, index) => {
    const checked = validator.validateAs('lease_event_recorded', event as unknown as JsonValue);
    return checked.valid ? [] : [`line ${String(index + 1)}: ${JSON.stringify(checked.violations)}`];
  });
}
