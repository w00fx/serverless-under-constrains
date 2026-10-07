// P2 through the frozen-assembly binding (design §9.8 D1-D4; BR-RUA-040, BR-RUA-050): the deploy is
// asked for the assembly the execution manifest pins, and the trials may start only when the frozen
// resource manifest succeeded with no reason and names every target. A manifest whose outputs do
// not resolve keeps the trials back with that reason, and a deploy that froze no manifest leaves
// cleanup nothing it can prove it owns, so the lease is kept for recovery.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { executionTargetsOf, STACK_OUTPUT_KEYS } from '../../../src/execution-lifecycle/execution-targets.ts';
import {
  FrozenAssemblyExecutionProvisioner,
  withTargets,
} from '../../../src/execution-lifecycle/execution-provisioner.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import type { Sha256Hex } from '../../../src/record-contract/primitives.ts';
import type { ResourceManifest } from '../../../src/record-contract/records/group-a/resource_manifest.ts';
import { resourceManifest } from '../../support/cleanup/cleanup-fixtures.ts';
import { offlineExecution } from '../../support/offline-cloud/offline-execution.ts';
import { ScriptedAssemblyProvisioner } from './fakes/scripted-assembly-provisioner.ts';
import { admittedOf } from './support/execution-fixtures.ts';
import { RunnerWorld } from './support/runner-world.ts';

const admitted = admittedOf(offlineExecution('run'));
const REFUSED = { code: 'DECLARED_TAGS_UNREADABLE', subject: 'BR-RUA-050', detail: 'the tags were refused' };

function withProbeVersion(version: string): ResourceManifest {
  const manifest = resourceManifest();
  return {
    ...manifest,
    outputs: [
      ...manifest.outputs,
      { key: STACK_OUTPUT_KEYS.probeCallerFunctionName, value: 'suc1-aaaaaaaa-probe-caller' },
      { key: STACK_OUTPUT_KEYS.probeCallerVersion, value: version },
    ],
  };
}

describe('FrozenAssemblyExecutionProvisioner', () => {
  it('deploys the pinned assembly and reads the targets of a clean deploy', async () => {
    const manifest = withProbeVersion('4');
    const assembly = new ScriptedAssemblyProvisioner({ kind: 'frozen', manifest });
    const outcome = await new FrozenAssemblyExecutionProvisioner(assembly).provision(admitted);
    assert.deepEqual(assembly.subjects(), [
      {
        identity: admitted.identity,
        execution_manifest_sha256: admitted.manifest_sha256,
        deployment_assembly: admitted.manifest.deployment_assembly,
        package_directory: admitted.package_directory,
      },
    ]);
    const targets = executionTargetsOf(manifest);
    assert.ok(targets.ok);
    assert.deepEqual(outcome.targets, targets.value);
    assert.equal(outcome.targets.probe_caller?.version, '4');
    assert.deepEqual(outcome.reasons, []);
    assert.equal(outcome.resource_manifest, manifest);
  });

  it('keeps the targets back when provisioning named a reason', async () => {
    const reason = { code: 'STACK_ID_NOT_RECORDED', subject: 'BR-RUA-040', detail: 'scripted' };
    const assembly = new ScriptedAssemblyProvisioner({
      kind: 'frozen',
      manifest: resourceManifest(),
      reasons: [reason],
    });
    const outcome = await new FrozenAssemblyExecutionProvisioner(assembly).provision(admitted);
    assert.equal(outcome.targets, undefined);
    assert.deepEqual(outcome.reasons, [reason]);
    assert.ok(outcome.resource_manifest !== undefined);
  });

  it('keeps the targets back with the reason a succeeded manifest does not resolve them', async () => {
    const assembly = new ScriptedAssemblyProvisioner({ kind: 'frozen', manifest: withProbeVersion('$LATEST') });
    const outcome = await new FrozenAssemblyExecutionProvisioner(assembly).provision(admitted);
    assert.equal(outcome.targets, undefined);
    assert.deepEqual(
      outcome.reasons.map((reason) => reason.code),
      ['EXECUTION_TARGETS_UNRESOLVED'],
    );
  });

  it('passes on why no manifest was frozen, and names it when the provisioner did not', async () => {
    const refused = await new FrozenAssemblyExecutionProvisioner(
      new ScriptedAssemblyProvisioner({ kind: 'unfrozen', reasons: [REFUSED] }),
    ).provision(admitted);
    assert.deepEqual(refused, { reasons: [REFUSED] });
    const silent = await new FrozenAssemblyExecutionProvisioner(
      new ScriptedAssemblyProvisioner({ kind: 'unfrozen', reasons: [] }),
    ).provision(admitted);
    assert.deepEqual(
      silent.reasons.map((reason) => reason.code),
      ['RESOURCE_MANIFEST_ABSENT'],
    );
    assert.match(silent.reasons[0].detail, /named no reason; expected a frozen resource manifest/);
  });

  it('reads a manifest that did not succeed as no targets, whatever its outputs', () => {
    const outcome = withTargets({
      resource_manifest: resourceManifest('failed'),
      resource_manifest_sha256: 'b'.repeat(64) as Sha256Hex,
      outputs: [],
      reasons: [],
    });
    assert.equal(outcome.targets, undefined);
    assert.deepEqual(
      outcome.reasons.map((reason) => reason.code),
      ['EXECUTION_TARGETS_UNRESOLVED'],
    );
  });
});

describe('ExecutionRunner over a deploy that froze no manifest', () => {
  it('fails provisioning, cleans nothing it cannot prove it owns and keeps the lease for recovery', async () => {
    const world = await RunnerWorld.create({
      deps: () => ({
        provisioner: new FrozenAssemblyExecutionProvisioner(
          new ScriptedAssemblyProvisioner({ kind: 'unfrozen', reasons: [REFUSED] }),
        ),
      }),
    });
    const outcome = await world.run();
    const events = world.runnerEvents();
    assert.ok(events.includes('PROVISIONING:failed'));
    assert.ok(events.includes('CLEANUP:failed'));
    assert.equal(events.includes('TRIALS:started'), false);
    const cleanup = world
      .journal(EXECUTION_PATHS.runnerJournal)
      .find((event) => event['phase'] === 'CLEANUP' && event['status'] === 'failed');
    assert.match(JSON.stringify(cleanup?.['reasons']), /RESOURCE_MANIFEST_ABSENT/);
    assert.ok(world.lease.calls().includes('finalize:unclean'));
    assert.equal(outcome.lease_status, 'recovery_required');
    assert.equal(world.account.log.firstSequenceOf('cloudformation', 'DeleteStack'), undefined);
  });
});
