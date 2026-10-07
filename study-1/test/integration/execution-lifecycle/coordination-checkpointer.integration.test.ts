// The coordination prefix checkpoint at transport freeze (design §10.2 P5; BR-RUA-044): asking for
// it opens PROBE_FREEZE in the runner journal and writes the checkpoint of the coordination
// journal's complete-line prefix once; a journal it cannot read, a prefix it cannot checkpoint and
// a checkpoint already written are each a reason, never a thrown error or a second checkpoint.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CoordinationPrefixCheckpointer } from '../../../src/execution-lifecycle/coordination-checkpointer.ts';
import { ExecutionPhaseJournal } from '../../../src/execution-lifecycle/execution-journal.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { OfflinePackageStorage } from '../../support/offline-cloud/offline-package-storage.ts';
import { lifecycleValidator } from './support/execution-fixtures.ts';
import { ProbeRunnerWorld } from './support/probe-runner-world.ts';

const world = await ProbeRunnerWorld.create();
assert.equal((await world.run()).package_finalized, true);
const JOURNAL = world.file(EXECUTION_PATHS.coordinationJournal) ?? new Uint8Array();
const { admitted, services } = world;
const directory = admitted.package_directory;

interface Checkpointing {
  readonly storage: OfflinePackageStorage;
  readonly checkpointer: CoordinationPrefixCheckpointer;
}

async function checkpointing(files: ReadonlyMap<string, Uint8Array>): Promise<Checkpointing> {
  const storage = new OfflinePackageStorage();
  for (const [path, bytes] of files) {
    await storage.writeOnce(`${directory}/${path}`, bytes);
  }
  const checkpointer = new CoordinationPrefixCheckpointer({
    files: storage,
    package_directory: directory,
    transport_probe_id: world.cloud.identity.transport_probe_id,
    execution_manifest_sha256: admitted.manifest_sha256,
    journal: new ExecutionPhaseJournal(admitted, storage, services),
    clock: services.clock,
  });
  return { storage, checkpointer };
}

function runnerEvents(storage: OfflinePackageStorage): readonly string[] {
  const text = new TextDecoder().decode(storage.filesUnder(directory).get(EXECUTION_PATHS.runnerJournal));
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as JsonObject)
    .map((event) => `${textOf(event['phase'])}:${textOf(event['status'])}`);
}

function textOf(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

describe('CoordinationPrefixCheckpointer', () => {
  it('opens P5 and writes the checkpoint of the complete-line prefix once', async () => {
    const { storage, checkpointer } = await checkpointing(new Map([[EXECUTION_PATHS.coordinationJournal, JOURNAL]]));
    assert.equal(checkpointer.invoked(), false);
    assert.equal(await checkpointer.writeCheckpoint(), undefined);
    assert.equal(checkpointer.invoked(), true);
    assert.deepEqual(runnerEvents(storage), ['PROBE_FREEZE:started']);
    const bytes = storage.filesUnder(directory).get(EXECUTION_PATHS.coordinationPrefixCheckpoint);
    const checkpoint = JSON.parse(new TextDecoder().decode(bytes)) as JsonObject;
    assert.equal(lifecycleValidator().validateAs('coordination_prefix_checkpoint', checkpoint).valid, true);
    assert.equal(checkpoint['prefix_byte_count'], JOURNAL.length);
    assert.equal(checkpoint['transport_probe_id'], world.cloud.identity.transport_probe_id);
  });

  it('names a coordination journal it cannot read', async () => {
    const { storage, checkpointer } = await checkpointing(new Map());
    const reason = await checkpointer.writeCheckpoint();
    assert.equal(reason?.code, 'COORDINATION_CHECKPOINT_NOT_WRITTEN');
    assert.match(
      reason.detail,
      /^coordination\/coordination-journal\.jsonl is unreadable \(NOT_FOUND: .*\); expected the coordination prefix checkpoint at transport freeze$/,
    );
    assert.equal(checkpointer.invoked(), true, 'P5 was reached');
    assert.equal(storage.filesUnder(directory).has(EXECUTION_PATHS.coordinationPrefixCheckpoint), false);
  });

  it('refuses a prefix whose last event cannot be read', async () => {
    const { checkpointer } = await checkpointing(
      new Map([[EXECUTION_PATHS.coordinationJournal, new TextEncoder().encode('{"not":"an event"}\n')]]),
    );
    const reason = await checkpointer.writeCheckpoint();
    assert.equal(reason?.code, 'PREFIX_LAST_EVENT_UNREADABLE');
  });

  it('names a checkpoint already written instead of writing a second', async () => {
    const existing = new TextEncoder().encode('{}\n');
    const { storage, checkpointer } = await checkpointing(
      new Map([
        [EXECUTION_PATHS.coordinationJournal, JOURNAL],
        [EXECUTION_PATHS.coordinationPrefixCheckpoint, existing],
      ]),
    );
    const reason = await checkpointer.writeCheckpoint();
    assert.equal(reason?.code, 'COORDINATION_CHECKPOINT_NOT_WRITTEN');
    assert.match(reason.detail, /coordination-prefix-checkpoint\.json was not written \(\w+: /);
    assert.deepEqual(storage.filesUnder(directory).get(EXECUTION_PATHS.coordinationPrefixCheckpoint), existing);
  });
});
