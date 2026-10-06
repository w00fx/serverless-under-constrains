// Operational recovery, `rua recover` (design §10.4, §11; BR-RUA-038, BR-RUA-043, BR-RUA-045): a
// finalized package whose cleanup left a leak is repaired from its own cleanup journal into one
// OPERATIONAL_RECOVERY amendment, the lease is released after the clean recovered closure, the
// original package is never rewritten, and every package recovery cannot act on is refused with a
// reason instead of a partial amendment.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resourceKey } from '../../../src/cleanup/resource-names.ts';
import { FUNCTION_VERSION_RESOURCE_TYPE } from '../../../src/cleanup/resource-types.ts';
import type { RecoveryDeps } from '../../../src/execution-lifecycle/operational-recovery.ts';
import { recoverExecution } from '../../../src/execution-lifecycle/operational-recovery.ts';
import { STACK_OUTPUT_KEYS } from '../../../src/execution-lifecycle/execution-targets.ts';
import { SessionExecutionLease } from '../../../src/execution-lifecycle/session-lease.ts';
import type { PackageFileSystem } from '../../../src/evidence-package/package-file-system.ts';
import { AMENDMENT_PATHS, EXECUTION_PATHS, PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonObject, JsonValue, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { SettableCleanupSafetyClock } from '../../support/cleanup/settable-cleanup-safety-clock.ts';
import { formatUtcMillis } from '../../../src/record-contract/timestamps.ts';
import { FakeLeaseStore } from '../../support/coordination-lease/fake-lease-store.ts';
import { DEEP_NESTING, towerText } from '../../support/kernel/deep-json.ts';
import { FOREIGN_OWNER } from '../../support/coordination-lease/lease-fixtures.ts';
import { OfflinePackageStorage } from '../../support/offline-cloud/offline-package-storage.ts';
import { ScriptedTrialRunner } from './fakes/scripted-trial-runner.ts';
import { RefusingPackageStorage } from './fakes/refusing-package-storage.ts';
import { lifecycleValidator } from './support/execution-fixtures.ts';
import { cleanupBindings } from './support/offline-account.ts';
import { RunnerWorld } from './support/runner-world.ts';

const FOREIGN_RUN_ID = '0f0f0f0f-0000-4000-8000-000000000001' as Uuid4;

interface LeakedExecution {
  readonly world: RunnerWorld;
  readonly store: FakeLeaseStore;
}

// An execution not run yet, over the real lease and its emulated coordination table.
async function leasedExecution(): Promise<LeakedExecution> {
  let store: FakeLeaseStore | undefined;
  const world = await RunnerWorld.create({
    deps: (built) => {
      store = new FakeLeaseStore({ clock: built.cloud.time });
      const journals = built.cloud.storage;
      return {
        trials: new ScriptedTrialRunner(),
        lease: new SessionExecutionLease(built.admitted, {
          store,
          journals,
          scheduler: built.cloud.time,
          services: built.services,
        }),
      };
    },
  });
  assert.ok(store !== undefined);
  return { world, store };
}

// A finished execution whose stack deletion failed once, retaining the provider version: cleanup
// ends partial, the audit finds the leak, and the real lease is left marked for recovery.
async function leakedExecution(): Promise<LeakedExecution> {
  const { world, store } = await leasedExecution();
  const manifest = JSON.parse(new TextDecoder().decode(world.resourceManifestBytes)) as {
    resources: readonly { physical_id: string }[];
  };
  const identifier = manifest.resources[0]?.physical_id ?? '';
  world.account.stack.failDeletionRetaining([
    resourceKey({ resource_type: FUNCTION_VERSION_RESOURCE_TYPE, identifier }),
  ]);
  const outcome = await world.run();
  assert.equal(outcome.cleanup_status, 'partial');
  assert.equal(outcome.leak_audit_status, 'leaks_detected');
  assert.equal(outcome.lease_status, 'recovery_required');
  return { world, store };
}

function recoveryDeps(
  world: RunnerWorld,
  store: FakeLeaseStore,
  files: PackageFileSystem = world.cloud.storage,
): RecoveryDeps {
  return {
    files,
    lease: store,
    cleanup: cleanupBindings(world.account, world.cloud.store, world.cloud.time),
    readers: world.deps.readers,
    safety: new SettableCleanupSafetyClock(),
    services: world.services,
  };
}

function snapshotOf(storage: OfflinePackageStorage, directory: string): ReadonlyMap<string, Uint8Array> {
  return new Map(storage.filesUnder(directory));
}

async function copyPackage(
  world: RunnerWorld,
  into: OfflinePackageStorage,
  skip: readonly string[] = [],
): Promise<void> {
  for (const [path, bytes] of world.cloud.packageFiles()) {
    if (!skip.includes(path)) {
      await into.writeOnce(`${world.admitted.package_directory}/${path}`, bytes);
    }
  }
}

async function withResourceManifest(
  world: RunnerWorld,
  edit: (manifest: Record<string, unknown>) => Record<string, unknown>,
): Promise<OfflinePackageStorage> {
  const storage = new OfflinePackageStorage();
  await copyPackage(world, storage, [EXECUTION_PATHS.resourceManifest]);
  const manifest = JSON.parse(new TextDecoder().decode(world.resourceManifestBytes)) as Record<string, unknown>;
  await storage.writeOnce(
    `${world.admitted.package_directory}/${EXECUTION_PATHS.resourceManifest}`,
    new TextEncoder().encode(`${JSON.stringify(edit(manifest))}\n`),
  );
  return storage;
}

function amendedSteps(storage: OfflinePackageStorage, directory: string): readonly JsonObject[] {
  const bytes = storage.filesUnder(directory).get(AMENDMENT_PATHS.cleanupResult) ?? new Uint8Array();
  return (JSON.parse(new TextDecoder().decode(bytes)) as JsonObject)['steps'] as readonly JsonObject[];
}

describe('recoverExecution', () => {
  it('repairs a leaked closure into one amendment and releases the lease', async () => {
    const { world, store } = await leakedExecution();
    const before = snapshotOf(world.cloud.storage, world.admitted.package_directory);
    const recovered = await world.drive(recoverExecution(world.admitted, recoveryDeps(world, store)));
    assert.ok(recovered.ok);
    const { record, amendment_directory: directory } = recovered.value;
    assert.deepEqual(record.original_closure, {
      cleanup_status: 'partial',
      leak_audit_status: 'leaks_detected',
      lease_status: 'recovery_required',
    });
    assert.deepEqual(record.recovered_closure, {
      cleanup_status: 'succeeded',
      leak_audit_status: 'clean',
      lease_status: 'released',
    });
    assert.equal(
      record.original_package_index_sha256,
      sha256Hex(before.get(EXECUTION_PATHS.packageIndex) ?? new Uint8Array()),
    );
    assert.ok(record.steps_run.length > 0 && record.steps_run.every((step) => step >= 3 && step <= 11));
    assert.ok(record.steps_run.includes(9), 'the deletion that failed runs again');
    assert.equal(lifecycleValidator().validate(record as unknown as JsonValue).valid, true);

    const lease = await store.read();
    assert.equal(lease.ok && lease.value?.lease_status, 'RELEASED');
    const amendment = world.cloud.storage.filesUnder(directory);
    assert.ok(amendment.has(AMENDMENT_PATHS.amendmentIndex));
    assert.ok(amendment.has(AMENDMENT_PATHS.operationalRecoveryRecord));
    assert.ok(amendment.has(record.cleanup_result_ref.artifact_path));
    assert.equal(
      sha256Hex(amendment.get(record.cleanup_result_ref.artifact_path) ?? new Uint8Array()),
      record.cleanup_result_ref.artifact_sha256,
    );
    assert.deepEqual(
      snapshotOf(world.cloud.storage, world.admitted.package_directory),
      before,
      'the package is never rewritten',
    );
  });

  it('chains a second recovery to the first, and finds the released lease released', async () => {
    const { world, store } = await leakedExecution();
    const first = await world.drive(recoverExecution(world.admitted, recoveryDeps(world, store)));
    const second = await world.drive(recoverExecution(world.admitted, recoveryDeps(world, store)));
    assert.ok(first.ok && second.ok);
    assert.match(second.value.amendment_directory, /\/0002-/);
    const firstIndex = world.cloud.storage
      .filesUnder(first.value.amendment_directory)
      .get(AMENDMENT_PATHS.amendmentIndex);
    const secondIndex = JSON.parse(
      new TextDecoder().decode(
        world.cloud.storage.filesUnder(second.value.amendment_directory).get(AMENDMENT_PATHS.amendmentIndex),
      ),
    ) as { parent_amendment_index_sha256: string };
    assert.equal(secondIndex.parent_amendment_index_sha256, sha256Hex(firstIndex ?? new Uint8Array()));
    assert.equal(second.value.record.original_closure.lease_status, 'recovery_required', 'the package is the original');
    assert.equal(second.value.record.recovered_closure.lease_status, 'released');
  });

  it('keeps a lease the original closure released, whoever holds the lease item now', async () => {
    const { world, store } = await leasedExecution();
    const outcome = await world.run();
    assert.equal(outcome.lease_status, 'released');
    // The lease item is shared by every execution: a later one acquired it after the release.
    store.takeOverBy(FOREIGN_OWNER, formatUtcMillis(world.cloud.time.now()), 9);
    const foreign = store.current();
    const recovered = await world.drive(recoverExecution(world.admitted, recoveryDeps(world, store)));
    assert.ok(recovered.ok);
    assert.equal(recovered.value.record.original_closure.lease_status, 'released');
    assert.equal(recovered.value.record.recovered_closure.lease_status, 'released', 'recovery never degrades it');
    assert.deepEqual(recovered.value.record.reasons, []);
    assert.deepEqual(store.current(), foreign, 'the later execution keeps its lease');
  });

  it('reports a lease it could not repair, and leaves it unverified', async () => {
    const { world, store } = await leakedExecution();
    store.failNextReads(10, 'ProvisionedThroughputExceededException');
    store.failNextWrites(10, { kind: 'definitive_failure', code: 'ProvisionedThroughputExceededException' });
    const recovered = await world.drive(recoverExecution(world.admitted, recoveryDeps(world, store)));
    assert.ok(recovered.ok);
    assert.equal(recovered.value.record.recovered_closure.lease_status, 'unverified');
    assert.deepEqual(
      recovered.value.record.reasons.map((reason) => reason.code),
      ['LEASE_NOT_REPAIRED'],
    );
  });

  it('counts a missing cleanup result as failed and a missing audit as inconclusive', async () => {
    const { world, store } = await leakedExecution();
    const storage = new OfflinePackageStorage();
    await copyPackage(world, storage, [EXECUTION_PATHS.cleanupResult, EXECUTION_PATHS.leakAuditResult]);
    const recovered = await world.drive(recoverExecution(world.admitted, recoveryDeps(world, store, storage)));
    assert.ok(recovered.ok);
    assert.deepEqual(recovered.value.record.original_closure, {
      cleanup_status: 'failed',
      leak_audit_status: 'inconclusive',
      lease_status: 'recovery_required',
    });
  });

  it('counts a cleanup result that never reached a terminal status as failed', async () => {
    const { world, store } = await leakedExecution();
    const storage = new OfflinePackageStorage();
    await copyPackage(world, storage, [EXECUTION_PATHS.cleanupResult]);
    const result = JSON.parse(new TextDecoder().decode(world.file(EXECUTION_PATHS.cleanupResult))) as Record<
      string,
      unknown
    >;
    const { completed_at: _completed, ...unfinished } = result;
    const running = new TextEncoder().encode(`${JSON.stringify({ ...unfinished, cleanup_status: 'running' })}\n`);
    await storage.writeOnce(`${world.admitted.package_directory}/${EXECUTION_PATHS.cleanupResult}`, running);
    const recovered = await world.drive(recoverExecution(world.admitted, recoveryDeps(world, store, storage)));
    assert.ok(recovered.ok);
    assert.equal(recovered.value.record.original_closure.cleanup_status, 'failed');
  });

  it('rebuilds a cleanup without a journal from scratch, leaving late evidence untouched', async () => {
    const { world, store } = await leakedExecution();
    const storage = new OfflinePackageStorage();
    await copyPackage(world, storage, [EXECUTION_PATHS.cleanupJournal]);
    const recovered = await world.drive(recoverExecution(world.admitted, recoveryDeps(world, store, storage)));
    assert.ok(recovered.ok);
    const late = amendedSteps(storage, recovered.value.amendment_directory).filter((step) => Number(step['step']) <= 2);
    assert.deepEqual(
      late.map((step) => [step['step'], step['status'], (step['reasons'] as readonly JsonObject[])[0]?.['code']]),
      [
        [1, 'skipped', 'OUTSIDE_RECOVERY_SCOPE'],
        [2, 'skipped', 'OUTSIDE_RECOVERY_SCOPE'],
      ],
    );
  });

  it('cleans from the recorded mappings when the deployed outputs are unreadable', async () => {
    const { world, store } = await leakedExecution();
    const storage = await withResourceManifest(world, (manifest) => ({
      ...manifest,
      // A source queue without its DLQ: the deployed targets cannot be read.
      outputs: [
        ...(manifest['outputs'] as readonly JsonObject[]),
        { key: STACK_OUTPUT_KEYS.conventionalSourceQueueUrl, value: 'https://sqs.ca-central-1.amazonaws.com/1/source' },
      ],
    }));
    const recovered = await world.drive(recoverExecution(world.admitted, recoveryDeps(world, store, storage)));
    assert.ok(recovered.ok);
    assert.equal(recovered.value.record.recovered_closure.cleanup_status, 'succeeded');
  });

  // A-05: every package file recovery reads comes from disk; hostile ones degrade what recovery
  // knows of the original closure, and never throw.
  it('stays total on package files nested 100,000 levels deep, past the double range or with inherited names', async () => {
    const { world, store } = await leakedExecution();
    const hostile = [
      towerText('mixed', DEEP_NESTING, '1'),
      '{"schema_version":1e400}',
      '{"__proto__":{"schema_version":1},"constructor":{"record_type":"cleanup_result"}}',
    ];
    const read = new Map<string, readonly JsonValue[]>();
    for (const path of [
      EXECUTION_PATHS.cleanupResult,
      EXECUTION_PATHS.leakAuditResult,
      EXECUTION_PATHS.coordinationJournal,
      EXECUTION_PATHS.cleanupJournal,
    ]) {
      const closures: JsonValue[] = [];
      for (const text of hostile) {
        const storage = new OfflinePackageStorage();
        await copyPackage(world, storage, [path]);
        await storage.writeOnce(`${world.admitted.package_directory}/${path}`, new TextEncoder().encode(`${text}\n`));
        const recovered = await world.drive(recoverExecution(world.admitted, recoveryDeps(world, store, storage)));
        assert.ok(recovered.ok, `${path} holding hostile bytes is still recovered`);
        closures.push(recovered.value.record.original_closure as unknown as JsonValue);
      }
      read.set(path, closures);
    }
    const original = {
      cleanup_status: 'partial',
      leak_audit_status: 'leaks_detected',
      lease_status: 'recovery_required',
    };
    const each = (closure: Record<string, string>): readonly JsonValue[] =>
      hostile.map(() => ({ ...original, ...closure }));
    assert.deepEqual(read.get(EXECUTION_PATHS.cleanupResult), each({ cleanup_status: 'failed' }));
    assert.deepEqual(read.get(EXECUTION_PATHS.leakAuditResult), each({ leak_audit_status: 'inconclusive' }));
    assert.deepEqual(read.get(EXECUTION_PATHS.coordinationJournal), each({ lease_status: 'unverified' }));
    assert.deepEqual(read.get(EXECUTION_PATHS.cleanupJournal), each({}));

    for (const text of hostile) {
      const storage = new OfflinePackageStorage();
      await copyPackage(world, storage, [EXECUTION_PATHS.resourceManifest]);
      await storage.writeOnce(
        `${world.admitted.package_directory}/${EXECUTION_PATHS.resourceManifest}`,
        new TextEncoder().encode(`${text}\n`),
      );
      const recovered = await recoverExecution(world.admitted, recoveryDeps(world, store, storage));
      assert.equal(!recovered.ok && recovered.error[0]?.code, 'RESOURCE_MANIFEST_UNREADABLE');
    }
  });

  it('keeps the lease marked for recovery when the recovered closure is still not clean', async () => {
    const { world, store } = await leakedExecution();
    world.account.stack.failDeleteRequests();
    const recovered = await world.drive(recoverExecution(world.admitted, recoveryDeps(world, store)));
    assert.ok(recovered.ok);
    assert.notEqual(recovered.value.record.recovered_closure.cleanup_status, 'succeeded');
    assert.equal(recovered.value.record.recovered_closure.lease_status, 'recovery_required');
    const lease = await store.read();
    assert.equal(lease.ok && lease.value?.lease_status, 'RECOVERY_REQUIRED');
  });
});

describe('recoverExecution refusals', () => {
  it('refuses a package that was never finalized', async () => {
    const world = await RunnerWorld.create();
    const recovered = await recoverExecution(
      world.admitted,
      recoveryDeps(world, new FakeLeaseStore({ clock: world.cloud.time })),
    );
    assert.equal(!recovered.ok && recovered.error[0]?.code, 'PACKAGE_NOT_FINALIZED');
  });

  it('refuses a finalized package without a readable resource manifest', async () => {
    const { world, store } = await leakedExecution();
    const storage = new OfflinePackageStorage();
    await copyPackage(world, storage, [EXECUTION_PATHS.resourceManifest]);
    const recovered = await recoverExecution(world.admitted, recoveryDeps(world, store, storage));
    assert.equal(!recovered.ok && recovered.error[0]?.code, 'RESOURCE_MANIFEST_UNREADABLE');
  });

  it('refuses a package it cannot list', async () => {
    const { world, store } = await leakedExecution();
    world.cloud.storage.failNextLists(1);
    const recovered = await recoverExecution(world.admitted, recoveryDeps(world, store));
    assert.equal(!recovered.ok && recovered.error[0]?.code, 'PACKAGE_UNREADABLE');
  });

  it('refuses a resource manifest of another execution', async () => {
    const { world, store } = await leakedExecution();
    const storage = new OfflinePackageStorage();
    await copyPackage(world, storage, [EXECUTION_PATHS.resourceManifest]);
    const manifest = JSON.parse(new TextDecoder().decode(world.resourceManifestBytes)) as Record<string, unknown>;
    const foreign = { ...manifest, run_id: FOREIGN_RUN_ID };
    await storage.writeOnce(
      `${world.admitted.package_directory}/${EXECUTION_PATHS.resourceManifest}`,
      new TextEncoder().encode(`${JSON.stringify(foreign)}\n`),
    );
    const recovered = await recoverExecution(world.admitted, recoveryDeps(world, store, storage));
    assert.equal(!recovered.ok && recovered.error[0]?.code, 'OWNERSHIP_CONTEXT_INVALID');
  });

  it('refuses when the existing amendments cannot be read', async () => {
    const { world, store } = await leakedExecution();
    const storage = new RefusingPackageStorage();
    await copyPackage(world, storage);
    storage.refuseListing(PACKAGE_LAYOUT.amendmentsDirectory(world.admitted.identity));
    const recovered = await world.drive(recoverExecution(world.admitted, recoveryDeps(world, store, storage)));
    assert.equal(!recovered.ok && recovered.error[0]?.code, 'AMENDMENTS_UNREADABLE');
  });

  it('reports an amendment it could not write', async () => {
    const { world, store } = await leakedExecution();
    const storage = new RefusingPackageStorage();
    await copyPackage(world, storage);
    storage.refuseWritesUnder(`${PACKAGE_LAYOUT.amendmentsDirectory(world.admitted.identity)}/`);
    const recovered = await world.drive(recoverExecution(world.admitted, recoveryDeps(world, store, storage)));
    assert.equal(!recovered.ok && recovered.error[0]?.code, 'AMENDMENT_NOT_WRITTEN');
    assert.match(!recovered.ok ? (recovered.error[0]?.detail ?? '') : '', /IO_ERROR: ENOSPC/);
  });

  it('refuses to chain onto a torn earlier amendment', async () => {
    const { world, store } = await leakedExecution();
    const amendments = PACKAGE_LAYOUT.amendmentsDirectory(world.admitted.identity);
    world.cloud.storage.seedRaw(`${amendments}/0001-torn/payload/cleanup-result.json`, new Uint8Array([0x7b]));
    const recovered = await world.drive(recoverExecution(world.admitted, recoveryDeps(world, store)));
    assert.deepEqual(!recovered.ok && recovered.error.map((reason) => reason.code), ['PARENT_MISMATCH']);
    assert.equal(world.cloud.storage.filesUnder(`${amendments}/0002-`).size, 0, 'nothing is written');
  });
});
