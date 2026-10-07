// `rua recover` over the real `recoverExecution`, the offline cloud and the real lease (design
// §10.4, §11; BR-RUA-038, BR-RUA-045, BR-RUA-048): a leaked execution is repaired into one
// OPERATIONAL_RECOVERY amendment and exits 0 with the lease released; a recovery that is still not
// clean exits 6 and one that leaves the lease unverified exits 7; the command refuses before any
// recovery a wrong confirmation (2) and a frozen resource manifest that cannot bind discovery (5);
// a refusal of the recovery itself is 5, and an amendment that could not be stored 10.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { discoveryTargetsOf } from '../../../src/cleanup/discovery-targets.ts';
import { recoverExecution } from '../../../src/execution-lifecycle/operational-recovery.ts';
import type { PackageFileSystem } from '../../../src/evidence-package/package-file-system.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT, executionIdOf } from '../../../src/evidence-package/package-layout.ts';
import type { RecoveryRequest } from '../../../src/operator-cli/recover-command.ts';
import { RecoverCommand } from '../../../src/operator-cli/recover-command.ts';
import type { ResourceManifest } from '../../../src/record-contract/records/group-a/resource_manifest.ts';
import { FakeLeaseStore } from '../../support/coordination-lease/fake-lease-store.ts';
import { OfflinePackageStorage } from '../../support/offline-cloud/offline-package-storage.ts';
import { runCli } from '../../unit/operator-cli/support/cli-harness.ts';
import type { CliRun } from '../../unit/operator-cli/support/cli-harness.ts';
import { STORED_EVIDENCE_ROOT, packageOperand } from '../../unit/operator-cli/support/stored-packages.ts';
import { RefusingPackageStorage } from '../execution-lifecycle/fakes/refusing-package-storage.ts';
import { lifecycleValidator } from '../execution-lifecycle/support/execution-fixtures.ts';
import { RunnerWorld } from '../execution-lifecycle/support/runner-world.ts';
import { copyEvidence, leakedExecution, recoveryDepsOf } from './support/offline-executions.ts';

interface Recovery {
  readonly run: CliRun;
  readonly requests: readonly RecoveryRequest[];
}

// Runs `recover` with the recovery bound to the world's offline account, lease store and `files`.
async function recover(
  world: RunnerWorld,
  store: FakeLeaseStore,
  files: PackageFileSystem = world.cloud.storage,
  confirmation: string = executionIdOf(world.admitted.identity),
): Promise<Recovery> {
  const requests: RecoveryRequest[] = [];
  const command = new RecoverCommand({
    files: (): PackageFileSystem => files,
    validator: lifecycleValidator(),
    recover: (request): ReturnType<typeof recoverExecution> => {
      requests.push(request);
      return recoverExecution(request.admitted, recoveryDepsOf(world, store, files));
    },
  });
  const argv = [
    'recover',
    packageOperand(world.admitted.identity),
    '--confirm-cloud-mutation',
    confirmation,
    '--evidence-root',
    STORED_EVIDENCE_ROOT,
  ];
  const run = await world.drive(runCli(argv, [command]));
  return { run, requests };
}

async function copiedPackage(world: RunnerWorld, into: OfflinePackageStorage, skip: string): Promise<void> {
  const skipped = `${world.admitted.package_directory}/${skip}`;
  await copyEvidence(world, into, (path, bytes) => (path === skipped ? undefined : bytes));
}

describe('recover', () => {
  it('repairs a leaked execution into one amendment bound to the frozen discovery targets (exit 0)', async () => {
    const { world, store } = await leakedExecution();
    const { run, requests } = await recover(world, store);
    assert.equal(run.exit_code, 0, JSON.stringify(run.result.reasons));
    assert.equal(run.result.run_id, executionIdOf(world.admitted.identity));
    const [written] = run.result.written_paths;
    assert.match(
      written ?? '',
      new RegExp(`^${PACKAGE_LAYOUT.amendmentsDirectory(world.admitted.identity)}/0001-[^/]+/amendment-index\\.json$`),
    );
    assert.deepEqual(run.result.result_record?.['recovered_closure'], {
      cleanup_status: 'succeeded',
      leak_audit_status: 'clean',
      lease_status: 'released',
    });
    const manifest = JSON.parse(new TextDecoder().decode(world.resourceManifestBytes)) as ResourceManifest;
    const expected = discoveryTargetsOf({ manifest, execution: world.admitted.identity });
    assert.ok(expected.ok);
    assert.deepEqual(
      requests.map((request) => request.targets),
      [expected.value],
    );
    assert.equal(requests[0]?.evidence_root, STORED_EVIDENCE_ROOT);
    assert.deepEqual(run.stderr_lines, [`recovering ${world.admitted.package_directory}`]);
  });

  it('exits 6 when the recovered closure is still not clean', async () => {
    const { world, store } = await leakedExecution();
    world.account.stack.failDeleteRequests();
    const { run } = await recover(world, store);
    assert.equal(run.exit_code, 6, JSON.stringify(run.result.reasons));
    assert.equal(run.result.reasons.at(-1)?.code, 'OPERATIONAL_CLOSURE_NOT_CLEAN');
    assert.ok(run.result.written_paths.length === 1, 'the amendment is still written');
  });

  it('exits 7 when the lease could not be repaired, with the recovery reasons first', async () => {
    const { world, store } = await leakedExecution();
    store.failNextReads(10, 'ProvisionedThroughputExceededException');
    store.failNextWrites(10, { kind: 'definitive_failure', code: 'ProvisionedThroughputExceededException' });
    const { run } = await recover(world, store);
    assert.equal(run.exit_code, 7);
    assert.deepEqual(
      run.result.reasons.map((reason) => reason.code),
      ['LEASE_NOT_REPAIRED', 'LEASE_UNVERIFIED'],
    );
  });

  it('refuses a confirmation that is not the execution id before recovering', async () => {
    const { world, store } = await leakedExecution();
    const { run, requests } = await recover(world, store, world.cloud.storage, 'coordination');
    assert.equal(run.exit_code, 2);
    assert.deepEqual(requests, []);
  });

  it('refuses a package whose frozen resource manifest is absent, invalid or of another execution', async () => {
    const { world, store } = await leakedExecution();
    const manifestPath = `${world.admitted.package_directory}/${EXECUTION_PATHS.resourceManifest}`;
    const absent = new OfflinePackageStorage();
    await copiedPackage(world, absent, EXECUTION_PATHS.resourceManifest);
    const invalid = new OfflinePackageStorage();
    await copiedPackage(world, invalid, EXECUTION_PATHS.resourceManifest);
    await invalid.writeOnce(manifestPath, new TextEncoder().encode('{"record_type":"resource_manifest"}\n'));
    const foreign = new OfflinePackageStorage();
    await copiedPackage(world, foreign, EXECUTION_PATHS.resourceManifest);
    const manifest = JSON.parse(new TextDecoder().decode(world.resourceManifestBytes)) as Record<string, unknown>;
    await foreign.writeOnce(
      manifestPath,
      new TextEncoder().encode(`${JSON.stringify({ ...manifest, run_id: '0f0f0f0f-0000-4000-8000-000000000001' })}\n`),
    );
    const cases: readonly (readonly [OfflinePackageStorage, string, RegExp])[] = [
      [
        absent,
        'RESOURCE_MANIFEST_UNREADABLE',
        / cannot be read \(NOT_FOUND\); expected the resource manifest P2 froze$/,
      ],
      [
        invalid,
        'RESOURCE_MANIFEST_UNREADABLE',
        / is not a valid resource_manifest; expected the resource manifest P2 froze$/,
      ],
      [foreign, 'DISCOVERY_TARGETS_UNRESOLVED', /./],
    ];
    for (const [files, code, detail] of cases) {
      const { run, requests } = await recover(world, store, files);
      assert.equal(run.exit_code, 5, code);
      assert.equal(run.result.run_id, executionIdOf(world.admitted.identity));
      assert.match(run.result.reasons[0]?.detail ?? '', detail);
      assert.equal(run.result.reasons[0]?.code, code);
      assert.deepEqual(requests, []);
    }
  });

  it('refuses an operand that is not a package directory as a usage error', async () => {
    const world = await RunnerWorld.create();
    const command = new RecoverCommand({
      files: (): PackageFileSystem => world.cloud.storage,
      validator: lifecycleValidator(),
      recover: (): never => assert.fail('never recovered'),
    });
    const run = await runCli(
      [
        'recover',
        `${STORED_EVIDENCE_ROOT}/runs`,
        '--confirm-cloud-mutation',
        'x',
        '--evidence-root',
        STORED_EVIDENCE_ROOT,
      ],
      [command],
    );
    assert.equal(run.exit_code, 2);
  });

  it('exits 5 when the recovery refuses an unfinalized package', async () => {
    const world = await RunnerWorld.create();
    const { run } = await recover(world, new FakeLeaseStore({ clock: world.cloud.time }));
    assert.equal(run.exit_code, 5);
    assert.deepEqual(
      run.result.reasons.map((reason) => reason.code),
      ['PACKAGE_NOT_FINALIZED'],
    );
  });

  it('exits 10 when the amendment could not be stored', async () => {
    const { world, store } = await leakedExecution();
    const storage = new RefusingPackageStorage();
    await copyEvidence(world, storage);
    storage.refuseWritesUnder(`${PACKAGE_LAYOUT.amendmentsDirectory(world.admitted.identity)}/`);
    const { run } = await recover(world, store, storage);
    assert.equal(run.exit_code, 10);
    assert.equal(run.result.reasons[0]?.code, 'AMENDMENT_NOT_WRITTEN');
  });
});
