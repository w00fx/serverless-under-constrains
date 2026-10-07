// What a finalized package says about its closure (design §7, §8.13, §8.17, §10.4; BR-RUA-043,
// BR-RUA-047), over packages the real runner and the real recovery wrote: the original index
// digest, the frozen resource manifest, the first mutation (LEASE_ACQUISITION started), the cleanup
// terminal instant and the effective closure; a whole OPERATIONAL_RECOVERY amendment replaces the
// closure and extends the terminal instant, and a recovery whose record or index does not match is
// ignored. Refusals: an unreadable package, an unfinalized one, an unreadable amendments directory.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AMENDMENT_PATHS, EXECUTION_PATHS, PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import { readPackageClosure, resourcesProvenGone } from '../../../src/operator-cli/package-closure.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import { OfflinePackageStorage } from '../../support/offline-cloud/offline-package-storage.ts';
import { RefusingPackageStorage } from '../execution-lifecycle/fakes/refusing-package-storage.ts';
import { lifecycleValidator } from '../execution-lifecycle/support/execution-fixtures.ts';
import { RunnerWorld } from '../execution-lifecycle/support/runner-world.ts';
import { copyEvidence, leakedExecution, recoveredExecution } from './support/offline-executions.ts';

const validator = lifecycleValidator();

function textOf(value: JsonObject[string] | undefined): string {
  return typeof value === 'string' ? value : '';
}

describe('readPackageClosure', () => {
  it('reads the original closure of a clean run', async () => {
    const world = await RunnerWorld.create();
    await world.run();
    const closure = await readPackageClosure(world.cloud.storage, world.admitted, validator);
    assert.equal(closure.ok, true);
    const started = world
      .journal(EXECUTION_PATHS.runnerJournal)
      .find((event) => event['phase'] === 'LEASE_ACQUISITION' && event['status'] === 'started');
    const cleanup = world.record(EXECUTION_PATHS.cleanupResult);
    assert.equal(closure.value.index_sha256, sha256Hex(world.file(EXECUTION_PATHS.packageIndex) ?? new Uint8Array()));
    assert.deepEqual(
      closure.value.resource_manifest,
      JSON.parse(new TextDecoder().decode(world.resourceManifestBytes)),
    );
    assert.equal(closure.value.first_mutation_at, textOf(started?.['occurred_at']));
    assert.equal(closure.value.cleanup_terminal_at, textOf(cleanup['completed_at']));
    assert.deepEqual(closure.value.closure, {
      cleanup_status: 'succeeded',
      leak_audit_status: 'clean',
      recovered: false,
    });
    assert.equal(resourcesProvenGone(closure.value.closure), true);
    assert.equal(closure.value.files.length, world.cloud.packageFiles().size);
  });

  it('reads a leaked closure as not proving the resources gone', async () => {
    const { world } = await leakedExecution();
    const closure = await readPackageClosure(world.cloud.storage, world.admitted, validator);
    assert.equal(closure.ok, true);
    assert.deepEqual(closure.value.closure, {
      cleanup_status: 'partial',
      leak_audit_status: 'leaks_detected',
      recovered: false,
    });
    assert.equal(resourcesProvenGone(closure.value.closure), false);
  });

  it('replaces the closure with a whole recovery and extends the terminal instant to it', async () => {
    const { world, recovery } = await recoveredExecution();
    const closure = await readPackageClosure(world.cloud.storage, world.admitted, validator);
    assert.equal(closure.ok, true);
    assert.deepEqual(closure.value.closure, {
      cleanup_status: 'succeeded',
      leak_audit_status: 'clean',
      recovered: true,
    });
    assert.equal(closure.value.cleanup_terminal_at, recovery.record.completed_at);
    const original = world.record(EXECUTION_PATHS.cleanupResult);
    assert.ok(Date.parse(recovery.record.completed_at) > Date.parse(textOf(original['completed_at'])));
  });

  it('ignores a recovery whose record bytes do not match its index', async () => {
    const { world } = await recoveredExecution();
    const storage = new OfflinePackageStorage();
    await copyEvidence(world, storage, (path, bytes) =>
      path.endsWith(`/${AMENDMENT_PATHS.operationalRecoveryRecord}`)
        ? new TextEncoder().encode(`${new TextDecoder().decode(bytes).trimEnd()} \n`)
        : bytes,
    );
    const closure = await readPackageClosure(storage, world.admitted, validator);
    assert.equal(closure.ok, true);
    assert.equal(closure.value.closure.recovered, false);
    assert.equal(closure.value.closure.cleanup_status, 'partial');
  });

  it('ignores a recovery whose index is not a valid amendment index of this package', async () => {
    const { world } = await recoveredExecution();
    const edits: readonly ((index: JsonObject) => JsonObject)[] = [
      (index): JsonObject => ({ ...index, amendment_kind: 'LATE_EVIDENCE' }),
      (index): JsonObject => ({ ...index, original_package_index_sha256: 'f'.repeat(64) }),
      (index): JsonObject => ({ ...index, execution_manifest_sha256: 'f'.repeat(64) }),
      (index): JsonObject => ({ ...index, entries: [] }),
      (): JsonObject => ({ record_type: 'amendment_index' }),
    ];
    for (const edit of edits) {
      const storage = new OfflinePackageStorage();
      await copyEvidence(world, storage, (path, bytes) =>
        path.endsWith(`/${AMENDMENT_PATHS.amendmentIndex}`)
          ? new TextEncoder().encode(
              `${JSON.stringify(edit(JSON.parse(new TextDecoder().decode(bytes)) as JsonObject))}\n`,
            )
          : bytes,
      );
      const closure = await readPackageClosure(storage, world.admitted, validator);
      assert.equal(closure.ok, true);
      assert.equal(closure.value.closure.recovered, false, JSON.stringify(edit({})));
    }
  });

  it('ignores a recovery whose index is missing or not JSON', async () => {
    const { world } = await recoveredExecution();
    for (const replacement of [undefined, new TextEncoder().encode('{')]) {
      const storage = new OfflinePackageStorage();
      await copyEvidence(world, storage, (path, bytes) =>
        path.endsWith(`/${AMENDMENT_PATHS.amendmentIndex}`) ? replacement : bytes,
      );
      const closure = await readPackageClosure(storage, world.admitted, validator);
      assert.equal(closure.ok, true);
      assert.equal(closure.value.closure.recovered, false);
    }
  });

  it('ignores a recovery whose record is missing or not a valid recovery record', async () => {
    const { world } = await recoveredExecution();
    for (const replacement of [
      undefined,
      new TextEncoder().encode('{"record_type":"operational_recovery_record"}\n'),
    ]) {
      const storage = new OfflinePackageStorage();
      await copyEvidence(world, storage, (path, bytes) =>
        path.endsWith(`/${AMENDMENT_PATHS.operationalRecoveryRecord}`) ? replacement : bytes,
      );
      const closure = await readPackageClosure(storage, world.admitted, validator);
      assert.equal(closure.ok, true);
      assert.equal(closure.value.closure.recovered, false);
    }
  });

  it('reads a package without a resource manifest, cleanup result or audit as having none of them', async () => {
    const { world } = await leakedExecution();
    const storage = new OfflinePackageStorage();
    const dropped = [
      EXECUTION_PATHS.resourceManifest,
      EXECUTION_PATHS.cleanupResult,
      EXECUTION_PATHS.leakAuditResult,
    ].map((path) => `${world.admitted.package_directory}/${path}`);
    await copyEvidence(world, storage, (path, bytes) => (dropped.includes(path) ? undefined : bytes));
    const closure = await readPackageClosure(storage, world.admitted, validator);
    assert.equal(closure.ok, true);
    assert.equal(closure.value.resource_manifest, undefined);
    assert.equal(closure.value.cleanup_terminal_at, undefined);
    assert.deepEqual(closure.value.closure, { recovered: false });
  });

  it('refuses an unfinalized package, an unreadable one and unreadable amendments', async () => {
    const fresh = await RunnerWorld.create();
    const unfinalized = await readPackageClosure(fresh.cloud.storage, fresh.admitted, validator);
    assert.deepEqual(unfinalized, {
      ok: false,
      error: {
        code: 'PACKAGE_NOT_FINALIZED',
        subject: 'BR-RUA-043',
        detail: `${fresh.admitted.package_directory} has no package-index.json; expected a finalized package`,
      },
    });
    const { world } = await leakedExecution();
    world.cloud.storage.failNextLists(1);
    const unreadable = await readPackageClosure(world.cloud.storage, world.admitted, validator);
    assert.equal(unreadable.ok, false);
    assert.equal(unreadable.error.code, 'PACKAGE_UNREADABLE');
    const refusing = new RefusingPackageStorage();
    await copyEvidence(world, refusing);
    refusing.refuseListing(PACKAGE_LAYOUT.amendmentsDirectory(world.admitted.identity));
    const amendments = await readPackageClosure(refusing, world.admitted, validator);
    assert.equal(amendments.ok, false);
    assert.equal(amendments.error.code, 'AMENDMENTS_UNREADABLE');
    assert.match(amendments.error.detail, /could not be read \(.+\); expected a readable amendments directory$/);
  });
});
