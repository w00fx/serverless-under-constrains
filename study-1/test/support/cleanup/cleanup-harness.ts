// One offline account for cleanup integration tests: the run's infrastructure on the stub
// discovery surfaces, the fake stack, consumers, durable executions and DLQ, the control table
// (InMemoryItemStore) behind the real step-5 safety release, and the cleanup journal as a JSONL
// file (MemoryAppendOnlyFile) written by the real JournalWriter. A second cleanup run reads the
// first run's journal back through `readCleanupHistory`, as a real re-run does.

import { readCleanupHistory } from '../../../src/cleanup/cleanup-history.ts';
import type { CleanupHistory } from '../../../src/cleanup/cleanup-history.ts';
import type { CleanupInput } from '../../../src/cleanup/cleanup-orchestrator.ts';
import { CleanupOrchestrator } from '../../../src/cleanup/cleanup-orchestrator.ts';
import type { LeakAuditRunner } from '../../../src/cleanup/cleanup-orchestrator.ts';
import { ControlTableBarrierRelease, TREATMENT_ITEM_SORT_KEY } from '../../../src/cleanup/control-barrier-release.ts';
import { LeakAuditor } from '../../../src/cleanup/leak-auditor.ts';
import type { OwnershipContext } from '../../../src/cleanup/ownership-context.ts';
import { resourceKey } from '../../../src/cleanup/resource-names.ts';
import { STACK_RESOURCE_TYPE } from '../../../src/cleanup/resource-types.ts';
import { JournalWriter } from '../../../src/event-journal/journal-writer.ts';
import { createJsonlJournalPort } from '../../../src/event-journal/jsonl-journal-port.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';
import type { RecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { InMemoryItemStore } from '../durable-store/in-memory-item-store.ts';
import { MemoryAppendOnlyFile } from '../event-journal/memory-append-only-file.ts';
import { RecordingMutationLog } from '../kernel/recording-mutation-log.ts';
import { SequentialUuidSource } from '../kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../kernel/virtual-time-scheduler.ts';
import type { MemberSpec } from './cleanup-fixtures.ts';
import {
  EPOCH_MS,
  EXECUTION,
  EXECUTION_ID,
  MANIFEST_SHA,
  NAMES,
  ownershipContext,
  runInfrastructure,
  STACK_ID,
  STACK_MEMBERS,
  STACK_NAME,
} from './cleanup-fixtures.ts';
import { FakeConsumerControl } from './fake-consumer-control.ts';
import { FakeDlqMessages } from './fake-dlq-messages.ts';
import { FakeDurableExecutions } from './fake-durable-executions.ts';
import { FakeStackApi } from './fake-stack-api.ts';
import { RecordingCleanupEvidence } from './recording-cleanup-evidence.ts';
import { RecordingResourceDeleter } from './recording-resource-deleter.ts';
import { SelfAdvancingSleeper } from './self-advancing-sleeper.ts';
import { SettableCleanupSafetyClock } from './settable-cleanup-safety-clock.ts';
import { StubDiscoverySurfaces } from './stub-discovery-surfaces.ts';

export const CLEANUP_JOURNAL_PATH = 'cleanup/cleanup-journal.jsonl';
export const TREATMENT_PARTITION = `${EXECUTION_ID}#cccccccc-0000-4000-8000-0000000000aa`;

let sharedValidator: RecordValidator | undefined;

/** The catalogue validator, compiled once per test process. */
export function cleanupValidator(): RecordValidator {
  sharedValidator ??= createRecordValidator();
  return sharedValidator;
}

export interface CleanupWorld {
  readonly time: VirtualTimeScheduler;
  readonly log: RecordingMutationLog;
  readonly surfaces: StubDiscoverySurfaces;
  readonly deleter: RecordingResourceDeleter;
  readonly executions: FakeDurableExecutions;
  readonly stack: FakeStackApi;
  readonly consumers: FakeConsumerControl;
  readonly dlq: FakeDlqMessages;
  readonly evidence: RecordingCleanupEvidence;
  readonly safety: SettableCleanupSafetyClock;
  readonly sleeper: SelfAdvancingSleeper;
  readonly store: InMemoryItemStore;
  readonly file: MemoryAppendOnlyFile;
  readonly ids: SequentialUuidSource;
}

export interface WorldOptions {
  /** The stack members that exist in the account (all by default). */
  readonly members?: readonly MemberSpec[];
  /** False when the stack was never created. */
  readonly stackExists?: boolean;
}

/**
 * A fresh account holding the run's infrastructure, at 2026-10-05T12:00:00.000Z virtual time.
 *
 * @example
 * const world = cleanupWorld();
 * const outcome = await cleanupOrchestrator(world).runNormal(cleanupInput(world));
 */
export function cleanupWorld(options: WorldOptions = {}): CleanupWorld {
  const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS });
  const log = new RecordingMutationLog();
  const surfaces = new StubDiscoverySurfaces();
  const members = options.members ?? STACK_MEMBERS;
  const stackExists = options.stackExists !== false;
  if (stackExists) {
    surfaces.place(...runInfrastructure(members));
  }
  const executions = new FakeDurableExecutions(surfaces, log, STACK_ID);
  const stack = new FakeStackApi(surfaces, executions, log, {
    stackId: STACK_ID,
    stackName: STACK_NAME,
    memberKeys: members.map((member) => resourceKey(member)),
    exists: stackExists,
  });
  const consumers = new FakeConsumerControl(log);
  if (stackExists) {
    consumers.add(NAMES.sourceMapping, 2);
  }
  return {
    time,
    log,
    surfaces,
    deleter: new RecordingResourceDeleter(surfaces, log),
    executions,
    stack,
    consumers,
    dlq: new FakeDlqMessages(log),
    evidence: new RecordingCleanupEvidence(),
    safety: new SettableCleanupSafetyClock(),
    sleeper: new SelfAdvancingSleeper(time),
    store: new InMemoryItemStore({ clock: time, mutationLog: log }),
    file: new MemoryAppendOnlyFile(),
    ids: new SequentialUuidSource('eeeeeeee'),
  };
}

/**
 * A cleanup orchestrator over the world, writing as one new `cleanup` source instance.
 *
 * @example
 * await cleanupOrchestrator(world, 2).runNormal(cleanupInput(world)); // a second run
 */
export function cleanupOrchestrator(world: CleanupWorld, run = 1, auditor?: LeakAuditRunner): CleanupOrchestrator {
  const journal = new JournalWriter({
    port: createJsonlJournalPort(CLEANUP_JOURNAL_PATH, world.file),
    source: 'cleanup',
    instanceId: `cccccccc-0000-4000-8000-${String(run).padStart(12, '0')}` as Uuid4,
    scope: { execution: EXECUTION, execution_manifest_sha256: MANIFEST_SHA, partition: { kind: 'execution' } },
    clock: world.time,
    ids: world.ids,
    maxDefinitiveRetries: 0,
  });
  return new CleanupOrchestrator({
    journal,
    evidence: world.evidence,
    consumers: world.consumers,
    barriers: new ControlTableBarrierRelease(world.store),
    durableExecutions: world.executions,
    dlq: world.dlq,
    stacks: world.stack,
    surfaces: world.surfaces,
    deleter: world.deleter,
    sleeper: world.sleeper,
    auditor:
      auditor ??
      new LeakAuditor({ surfaces: world.surfaces, clock: world.time, monotonic: world.time, sleeper: world.sleeper }),
    clock: world.time,
    safety: world.safety,
  });
}

/** What earlier runs wrote to the world's cleanup journal, read back as a re-run reads it. */
export function journalHistory(world: CleanupWorld): CleanupHistory {
  return readCleanupHistory(
    world.file.contents(CLEANUP_JOURNAL_PATH) ?? new Uint8Array(),
    { execution: EXECUTION, execution_manifest_sha256: MANIFEST_SHA },
    cleanupValidator(),
  );
}

/**
 * The cleanup input of the world's execution, with the history its journal holds so far.
 *
 * @example
 * cleanupInput(world, ownershipContext(resourceManifest('partial')));
 */
export function cleanupInput(world: CleanupWorld, ownership: OwnershipContext = ownershipContext()): CleanupInput {
  return {
    execution: EXECUTION,
    execution_manifest_sha256: MANIFEST_SHA,
    ownership,
    targets: {
      event_source_mapping_ids: [NAMES.sourceMapping],
      treatment_partitions: [TREATMENT_PARTITION],
      durable_function_names: [NAMES.durableFunction],
    },
    history: journalHistory(world),
  };
}

/** Seeds the treatment item of `partition` in `state`. */
export function seedTreatment(world: CleanupWorld, state: string, partition = TREATMENT_PARTITION): void {
  world.store.seed('control', { pk: partition, sk: TREATMENT_ITEM_SORT_KEY, state, version: 3 });
}

/** The stack's own resource key. */
export const STACK_KEY = resourceKey({ resource_type: STACK_RESOURCE_TYPE, identifier: STACK_ID });
