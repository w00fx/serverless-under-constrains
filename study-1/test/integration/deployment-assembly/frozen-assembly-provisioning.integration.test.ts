// Provisioning from the frozen assembly (design §9.8 D1-D4; BR-RUA-040, BR-RUA-042, BR-RUA-050,
// BR-RUA-053; D-25; addendum §2.4) over an in-memory package, the production CdkAssemblyDeployer on
// the FakeCommandRunner and the FakePostDeployReader:
// - the D1-D4 order: verified copy, `cdk deploy` of that copy, re-verified package, then the reads;
// - a copy that does not verify never reaches `cdk deploy`, and still freezes a `failed` manifest;
// - a failed deployment still journals its failure and freezes a `partial` manifest of what
//   CloudFormation created, with the stack id as ownership boundary (AC-RUA-011);
// - drift of the package copy (D3) is reported and keeps provisioning from succeeding;
// - the stored manifest digest is the one every trial manifest carries (AC-RUA-008);
// - the provider's immutable version is recorded and no provisioned concurrency exists (AC-RUA-053).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ownershipContextFromManifest, STUDY_BASELINE_EXCLUSIONS } from '../../../src/cleanup/ownership-context.ts';
import { proveOwnership } from '../../../src/cleanup/ownership.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonValue, UtcMillis } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { functionNameOf, stackIdOf } from '../../support/deployment-assembly/deployed-account.ts';
import { declaredTags, EXECUTION_ID, RUN_STACK } from '../../support/deployment-assembly/deployment-fixtures.ts';
import { FIXTURE_IDS } from '../../support/deployment-assembly/execution-template-fixture.ts';
import {
  COPY_DIR,
  FROZEN_DIR,
  journalLines,
  journalledEvents,
  provisioningRig,
  storedManifest,
  storedManifestBytes,
} from '../../support/deployment-assembly/provisioning-rig.ts';

const STACK_ID = stackIdOf(RUN_STACK);
const validator = createRecordValidator();

function assertSchemaValid(lines: readonly Readonly<Record<string, JsonValue>>[]): void {
  for (const line of lines) {
    const checked = validator.validateAs('provisioning_event_recorded', line);
    assert.ok(checked.valid, JSON.stringify(checked));
  }
}

function codes(reasons: readonly { readonly code: string }[]): readonly string[] {
  return reasons.map((reason) => reason.code);
}

describe('FrozenAssemblyProvisioner', () => {
  it('runs D1-D4 in order and freezes a succeeded manifest', async () => {
    const rig = await provisioningRig();
    const provisioned = await rig.provisioner.provision(rig.subject);
    assert.ok(provisioned.ok);
    assert.deepEqual(provisioned.value.reasons, []);
    assert.equal(provisioned.value.resource_manifest.provisioning_status, 'succeeded');
    assert.deepEqual(journalledEvents(rig), [
      'DEPLOY_COPY_VERIFIED',
      'DEPLOY_STARTED',
      'DEPLOY_SUCCEEDED',
      'PACKAGE_ASSEMBLY_REVERIFIED',
      'STACK_ID_RECORDED',
    ]);
    const [deploy, ...others] = rig.runner.invocations();
    assert.deepEqual(others, [], 'exactly one CLI run: the deployment');
    assert.ok(deploy !== undefined);
    assert.deepEqual(deploy.args.slice(1, 5), ['deploy', RUN_STACK, '--app', COPY_DIR]);
    assert.equal(deploy.args[deploy.args.indexOf('--outputs-file') + 1], `${COPY_DIR}/outputs.json`);
    assert.deepEqual(rig.runner.locksWritten(), [`${COPY_DIR}/read.4242.1.lock`], 'the lock lands in the copy');
    const reads = rig.reader.calls().map((call) => call.method);
    assert.deepEqual(reads.slice(0, 2), ['describeStack', 'listStackResources']);
    assert.deepEqual(rig.reader.calls()[1]?.args, [STACK_ID], 'resources are listed by the recorded stack id');
    assert.deepEqual(provisioned.value.outputs, [
      { key: 'ControllerFunctionName', value: 'suc1-3f1c2a9e-controller' },
      { key: 'ProviderVersion', value: '7' },
    ]);
  });

  it('journals the inventory digest, the stack name and the stack id, each caused by the step before', async () => {
    const rig = await provisioningRig();
    await rig.provisioner.provision(rig.subject);
    const lines = journalLines(rig);
    assert.equal(lines[0]?.['inventory_sha256'], rig.inventory.inventory_sha256);
    assert.equal(lines[1]?.['stack_name'], RUN_STACK);
    assert.equal(lines[3]?.['inventory_sha256'], rig.inventory.inventory_sha256);
    assert.equal(lines[4]?.['stack_id'], STACK_ID);
    assert.equal(lines[0]['causation_event_ids'], undefined, 'the first step has no cause');
    for (let index = 1; index < lines.length; index += 1) {
      assert.deepEqual(lines[index]?.['causation_event_ids'], [lines[index - 1]?.['event_id']]);
    }
    assert.ok(lines.every((line) => line['source'] === 'runner' && line['run_id'] === EXECUTION_ID));
    assertSchemaValid(lines);
  });

  it('ac008: the returned digest is the sha256 of the stored manifest bytes', async () => {
    const rig = await provisioningRig();
    const provisioned = await rig.provisioner.provision(rig.subject);
    assert.ok(provisioned.ok);
    const stored = await storedManifestBytes(rig);
    assert.equal(provisioned.value.resource_manifest_sha256, sha256Hex(stored));
    assert.deepEqual(await storedManifest(rig), JSON.parse(JSON.stringify(provisioned.value.resource_manifest)));
    assert.equal((await storedManifest(rig))['execution_manifest_sha256'], rig.subject.execution_manifest_sha256);
  });

  it('ac053: records the immutable provider version and no provisioned concurrency on any version or alias', async () => {
    const rig = await provisioningRig();
    const provisioned = await rig.provisioner.provision(rig.subject);
    assert.ok(provisioned.ok);
    const manifest = provisioned.value.resource_manifest;
    assert.equal(manifest.provider_version, '7');
    const configuration = manifest.configuration ?? [];
    const concurrency = configuration.filter((entry) => entry.attribute_path === 'ProvisionedConcurrencyConfig');
    assert.deepEqual(
      concurrency.map((entry) => [entry.logical_id, entry.canonical_json]),
      [
        [FIXTURE_IDS.conventionalAlias, 'null'],
        [FIXTURE_IDS.durableAlias, 'null'],
        [FIXTURE_IDS.providerVersion, 'null'],
      ],
    );
    const version = configuration.find(
      (entry) => entry.logical_id === FIXTURE_IDS.providerVersion && entry.attribute_path === 'Version',
    );
    assert.equal(version?.canonical_json, '"7"');
  });

  it('ac053: provisioned concurrency on the provider version fails provisioning', async () => {
    const rig = await provisioningRig();
    rig.account.concurrency[`${functionNameOf(FIXTURE_IDS.providerFunction)}:7`] = {
      RequestedProvisionedConcurrentExecutions: 1,
      AllocatedProvisionedConcurrentExecutions: 1,
      AvailableProvisionedConcurrentExecutions: 1,
      Status: 'READY',
    };
    const provisioned = await rig.provisioner.provision(rig.subject);
    assert.ok(provisioned.ok);
    assert.deepEqual(codes(provisioned.value.reasons), ['PROVISIONED_CONCURRENCY_PRESENT']);
    assert.equal(provisioned.value.resource_manifest.provisioning_status, 'partial');
    assert.equal((await storedManifest(rig))['provisioning_status'], 'partial');
  });

  it('never deploys a copy that does not verify, and freezes a failed manifest', async () => {
    const rig = await provisioningRig();
    rig.assembly_files.corrupt(`${FROZEN_DIR}/asset.abc123/index.mjs`);
    const provisioned = await rig.provisioner.provision(rig.subject);
    assert.ok(provisioned.ok);
    assert.deepEqual(rig.runner.invocations(), [], 'cdk deploy never ran');
    assert.deepEqual(rig.reader.calls(), [], 'nothing was deployed, so nothing is read');
    assert.deepEqual(journalledEvents(rig), ['DEPLOY_FAILED']);
    const [failed] = journalLines(rig);
    assert.deepEqual(codes(failed?.['reasons'] as { code: string }[]).slice(0, 2), [
      'STACK_NOT_DEPLOYED',
      'DEPLOY_COPY_NOT_VERIFIED',
    ]);
    assertSchemaValid(journalLines(rig));
    assert.equal(provisioned.value.resource_manifest.provisioning_status, 'failed');
    assert.ok(codes(provisioned.value.reasons).includes('DEPLOY_COPY_NOT_VERIFIED'));
    assert.equal((await storedManifest(rig))['provisioning_status'], 'failed');
  });

  it('never deploys into a staging directory that already holds files', async () => {
    const rig = await provisioningRig();
    await rig.assembly_files.createFile(`${COPY_DIR}/stale.lock`, new Uint8Array([1]), 0o644);
    const provisioned = await rig.provisioner.provision(rig.subject);
    assert.ok(provisioned.ok);
    assert.deepEqual(rig.runner.invocations(), []);
    assert.ok(codes(provisioned.value.reasons).includes('DEPLOY_COPY_NOT_EMPTY'));
    assert.equal(provisioned.value.resource_manifest.provisioning_status, 'failed');
  });

  it('ac011: a failed deployment leaves a journalled failure and a partial manifest that proves ownership', async () => {
    const rig = await provisioningRig();
    rig.runner.enqueue({ kind: 'exited', exit_code: 1, stdout: '', stderr: 'UPDATE_ROLLBACK_COMPLETE' });
    const stack = rig.account.stack;
    assert.ok(stack !== undefined);
    stack['StackStatus'] = 'ROLLBACK_COMPLETE';
    rig.account.resources = rig.account.resources.slice(0, 3).map((resource, index) => ({
      ...resource,
      ResourceStatus: index === 2 ? 'CREATE_FAILED' : 'CREATE_COMPLETE',
    }));
    const provisioned = await rig.provisioner.provision(rig.subject);
    assert.ok(provisioned.ok);
    assert.deepEqual(journalledEvents(rig), [
      'DEPLOY_COPY_VERIFIED',
      'DEPLOY_STARTED',
      'DEPLOY_FAILED',
      'PACKAGE_ASSEMBLY_REVERIFIED',
      'STACK_ID_RECORDED',
    ]);
    assert.deepEqual(
      rig.reader.calls().map((call) => call.method),
      ['describeStack', 'listStackResources'],
      'configuration is read only from a deployed stack',
    );
    assertSchemaValid(journalLines(rig));
    const manifest = provisioned.value.resource_manifest;
    assert.equal(manifest.provisioning_status, 'partial');
    assert.equal(manifest.stack_id, STACK_ID);
    assert.equal(manifest.resources.length, 3);
    assert.ok(codes(provisioned.value.reasons).includes('DEPLOY_COMMAND_FAILED'));
    assert.ok(codes(provisioned.value.reasons).includes('STACK_NOT_COMPLETE'));
    const context = ownershipContextFromManifest({
      manifest,
      execution: rig.subject.identity,
      execution_manifest_frozen_at: '2026-10-05T12:00:00.000Z' as UtcMillis,
      baseline: STUDY_BASELINE_EXCLUSIONS,
    });
    assert.ok(context.ok);
    const listed = manifest.resources[0];
    assert.ok(listed?.physical_id !== undefined);
    const runTags = declaredTags().map((tag) => ({ key: tag.key, value: tag.value }));
    assert.deepEqual(
      proveOwnership(
        {
          resource_type: listed.resource_type,
          identifier: listed.physical_id,
          surface: 'stack_resources',
          tags: { kind: 'tagged', tags: runTags },
        },
        context.value,
      ),
      { kind: 'owned', basis: 'resource_manifest_and_tags' },
    );
    assert.deepEqual(
      proveOwnership(
        {
          resource_type: 'AWS::CloudFormation::Stack',
          identifier: STACK_ID,
          surface: 'stack',
          tags: { kind: 'tagged', tags: runTags },
        },
        context.value,
      ),
      { kind: 'owned', basis: 'recorded_stack' },
    );
  });

  it('a deployment that created nothing freezes a failed manifest', async () => {
    const rig = await provisioningRig();
    rig.runner.enqueue({ kind: 'spawn_failed', detail: 'ENOENT' });
    rig.account.stack = undefined;
    const provisioned = await rig.provisioner.provision(rig.subject);
    assert.ok(provisioned.ok);
    assert.deepEqual(journalledEvents(rig), [
      'DEPLOY_COPY_VERIFIED',
      'DEPLOY_STARTED',
      'DEPLOY_FAILED',
      'PACKAGE_ASSEMBLY_REVERIFIED',
    ]);
    assert.deepEqual(
      rig.reader.calls().map((call) => call.method),
      ['describeStack'],
      'a stack that does not exist has no resources to list',
    );
    assert.equal(provisioned.value.resource_manifest.provisioning_status, 'failed');
    assert.equal(provisioned.value.resource_manifest.stack_id, undefined);
  });

  it('reports drift of the package copy (D3) and does not succeed', async () => {
    const rig = await provisioningRig({ deploy_staging_root: FROZEN_DIR });
    const provisioned = await rig.provisioner.provision(rig.subject);
    assert.ok(provisioned.ok);
    assert.equal(rig.runner.invocations().length, 1, 'the verified copy was deployed');
    assert.deepEqual(journalledEvents(rig), [
      'DEPLOY_COPY_VERIFIED',
      'DEPLOY_STARTED',
      'DEPLOY_SUCCEEDED',
      'STACK_ID_RECORDED',
    ]);
    assert.ok(provisioned.value.reasons.length > 0);
    assert.ok(provisioned.value.reasons.every((reason) => reason.subject === 'BR-RUA-042'));
    assert.equal(provisioned.value.resource_manifest.provisioning_status, 'partial');
  });
});
