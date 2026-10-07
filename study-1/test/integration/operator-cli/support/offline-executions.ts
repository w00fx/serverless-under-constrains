// Offline executions the operator-cli integration tests act on (design §10.2, §12.2): the
// execution-lifecycle worlds (the offline cloud, its account and the real `ExecutionRunner`), with
// the real `SessionExecutionLease` over the emulated coordination table where the lease's closure is
// the subject, and a leaked execution whose stack deletion retained the provider version. The
// package lives in the cloud's evidence storage at `<package_directory>/…`, so the commands read it
// with the operand `/operator/evidence/<package_directory>`.

import assert from 'node:assert/strict';

import { resourceKey } from '../../../../src/cleanup/resource-names.ts';
import { FUNCTION_VERSION_RESOURCE_TYPE } from '../../../../src/cleanup/resource-types.ts';
import type { ExecutionRunnerDeps } from '../../../../src/execution-lifecycle/execution-runner.ts';
import { recoverExecution } from '../../../../src/execution-lifecycle/operational-recovery.ts';
import type { RecoveryDeps, RecoveryOutcome } from '../../../../src/execution-lifecycle/operational-recovery.ts';
import { SessionExecutionLease } from '../../../../src/execution-lifecycle/session-lease.ts';
import type { PackageFileSystem } from '../../../../src/evidence-package/package-file-system.ts';
import { PACKAGE_LAYOUT } from '../../../../src/evidence-package/package-layout.ts';
import { ExecuteCommand } from '../../../../src/operator-cli/execute-commands.ts';
import type { ExecutionSession } from '../../../../src/operator-cli/execute-commands.ts';
import { ok } from '../../../../src/record-contract/primitives.ts';
import type { ExecutionKind, Result, StructuredReason } from '../../../../src/record-contract/primitives.ts';
import type { ResourceManifest } from '../../../../src/record-contract/records/group-a/resource_manifest.ts';
import { SettableCleanupSafetyClock } from '../../../support/cleanup/settable-cleanup-safety-clock.ts';
import { FakeLeaseStore } from '../../../support/coordination-lease/fake-lease-store.ts';
import { ScriptedTrialRunner } from '../../execution-lifecycle/fakes/scripted-trial-runner.ts';
import { lifecycleValidator } from '../../execution-lifecycle/support/execution-fixtures.ts';
import { cleanupBindings } from '../../execution-lifecycle/support/offline-account.ts';
import { RunnerWorld } from '../../execution-lifecycle/support/runner-world.ts';
import type { ProbeRunnerWorld } from '../../execution-lifecycle/support/probe-runner-world.ts';
import { ManualInterruptSource } from '../../../unit/operator-cli/support/manual-interrupt-source.ts';

/** An execution over the real lease and its emulated coordination table. */
export interface LeasedExecution {
  readonly world: RunnerWorld;
  readonly store: FakeLeaseStore;
}

/**
 * A run not executed yet, over the real lease; `deps` replaces further runner dependencies.
 *
 * @example
 * const { world, store } = await leasedExecution();
 */
export async function leasedExecution(
  deps: (world: RunnerWorld) => Partial<ExecutionRunnerDeps> = () => ({}),
): Promise<LeasedExecution> {
  let store: FakeLeaseStore | undefined;
  const world = await RunnerWorld.create({
    deps: (built) => {
      store = new FakeLeaseStore({ clock: built.cloud.time });
      return {
        lease: new SessionExecutionLease(built.admitted, {
          store,
          journals: built.cloud.storage,
          scheduler: built.cloud.time,
          services: built.services,
        }),
        ...deps(built),
      };
    },
  });
  assert.ok(store !== undefined);
  return { world, store };
}

/**
 * Makes the next stack deletion of `world` fail once, retaining the provider version, so cleanup
 * ends `partial`, the audit finds the leak and the real lease is left `recovery_required`.
 *
 * @example
 * retainProviderVersion(world); // then run the execution
 */
export function retainProviderVersion(world: RunnerWorld): void {
  const manifest = JSON.parse(new TextDecoder().decode(world.resourceManifestBytes)) as ResourceManifest;
  const identifier = manifest.resources[0]?.physical_id ?? '';
  world.account.stack.failDeletionRetaining([
    resourceKey({ resource_type: FUNCTION_VERSION_RESOURCE_TYPE, identifier }),
  ]);
}

/**
 * A finished run that leaked: trials never published (the scripted runner), cleanup `partial`, the
 * audit `leaks_detected` and the lease `recovery_required`.
 *
 * @example
 * const { world, store } = await leakedExecution();
 */
export async function leakedExecution(): Promise<LeasedExecution> {
  const leased = await leasedExecution(() => ({ trials: new ScriptedTrialRunner() }));
  retainProviderVersion(leased.world);
  const outcome = await leased.world.run();
  assert.equal(outcome.lease_status, 'recovery_required');
  return leased;
}

/**
 * Recovery dependencies over the world's offline account, its lease store and `files`.
 *
 * @example
 * await recoverExecution(world.admitted, recoveryDepsOf(world, store));
 */
export function recoveryDepsOf(
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

/** A leaked execution and the recovery that repaired it. */
export interface RecoveredExecution extends LeasedExecution {
  readonly recovery: RecoveryOutcome;
}

/**
 * A leaked run repaired by one clean OPERATIONAL_RECOVERY amendment.
 *
 * @example
 * const { world, recovery } = await recoveredExecution();
 */
export async function recoveredExecution(): Promise<RecoveredExecution> {
  const leaked = await leakedExecution();
  const recovered = await leaked.world.drive(
    recoverExecution(leaked.world.admitted, recoveryDepsOf(leaked.world, leaked.store)),
  );
  assert.ok(recovered.ok, 'the leaked run recovers');
  return { ...leaked, recovery: recovered.value };
}

/**
 * Copies the world's package and its amendments into `into`, through `edit`: it answers the bytes
 * to store at an evidence-root path, or undefined to leave the file out.
 *
 * @example
 * await copyEvidence(world, storage, (path, bytes) => (path.endsWith('index.json') ? undefined : bytes));
 */
export async function copyEvidence(
  world: RunnerWorld,
  into: PackageFileSystem,
  edit: (path: string, bytes: Uint8Array) => Uint8Array | undefined = (_path, bytes) => bytes,
): Promise<void> {
  const roots = [world.admitted.package_directory, PACKAGE_LAYOUT.amendmentsDirectory(world.admitted.identity)];
  const files = roots.flatMap((root) =>
    [...world.cloud.storage.filesUnder(root)].map(([path, bytes]) => [`${root}/${path}`, bytes] as const),
  );
  for (const [path, bytes] of files) {
    const stored = edit(path, bytes);
    if (stored !== undefined) {
      assert.equal((await into.writeOnce(path, stored)).ok, true, path);
    }
  }
}

/** The execute command over a world's real runner and storage. */
export interface WorldCommand {
  readonly command: ExecuteCommand;
  readonly interrupts: ManualInterruptSource;
}

/**
 * The `<kind> execute` command bound to `world`'s runner, as the composition binds it to AWS.
 *
 * @example
 * const { command } = executeCommandOver(world, 'RUN');
 */
export function executeCommandOver(
  world: RunnerWorld | ProbeRunnerWorld,
  kind: ExecutionKind,
  interrupts: ManualInterruptSource = new ManualInterruptSource(),
): WorldCommand {
  const command = new ExecuteCommand(kind, {
    files: (): PackageFileSystem => world.cloud.storage,
    validator: lifecycleValidator(),
    sessions: (): Result<ExecutionSession, StructuredReason> => ok(world.runner),
    interrupts,
  });
  return { command, interrupts };
}
