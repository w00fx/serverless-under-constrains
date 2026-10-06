// Every way provisioning from the frozen assembly can fall short (design §9.8 D1-D4; BR-RUA-040,
// BR-RUA-042, BR-RUA-050): unreadable or altered frozen inputs never reach `cdk deploy` and freeze a
// `failed` manifest; a failed stack read, an unwritten journal event, an existing manifest file and
// unreadable package copy are reasons, never throws; only unreadable declared tags and a manifest
// that fails its schema freeze nothing, because no valid manifest exists then.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { FrozenProvisioning } from '../../../src/deployment-assembly/frozen-assembly-provisioner.ts';
import type { Result, Sha256Hex, StructuredReason } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { RUN_STACK } from '../../support/deployment-assembly/deployment-fixtures.ts';
import { stackIdOf } from '../../support/deployment-assembly/deployed-account.ts';
import {
  FIXTURE_IDS,
  removeResource,
  runTemplate,
} from '../../support/deployment-assembly/execution-template-fixture.ts';
import {
  FROZEN_DIR,
  journalledEvents,
  PACKAGE_DIRECTORY,
  PROVISIONING_JOURNAL_PATH,
  provisioningRig,
  RESOURCE_MANIFEST_PATH,
  storedManifest,
} from '../../support/deployment-assembly/provisioning-rig.ts';
import type { ProvisioningRig } from '../../support/deployment-assembly/provisioning-rig.ts';
import { InMemorySchemaFileSystem } from '../../support/kernel/in-memory-schema-file-system.ts';

const SCHEMA_ROOT = new URL('../../../src/record-contract/schemas/', import.meta.url).pathname;
const INVENTORY_PATH = `${PACKAGE_DIRECTORY}/admission/deployment-assembly.inventory.json`;
const TEMPLATE_PATH = `${FROZEN_DIR}/${RUN_STACK}.template.json`;

function codes(reasons: readonly StructuredReason[]): readonly string[] {
  return reasons.map((reason) => reason.code);
}

function provisioned(result: Result<FrozenProvisioning, readonly StructuredReason[]>): FrozenProvisioning {
  if (!result.ok) {
    throw new Error(`provisioning built no manifest: ${JSON.stringify(result.error)}; expected one`);
  }
  return result.value;
}

async function failedBeforeDeploy(rig: ProvisioningRig, code: string): Promise<void> {
  const value = provisioned(await rig.provisioner.provision(rig.subject));
  assert.deepEqual(rig.runner.invocations(), [], 'cdk deploy never ran');
  assert.deepEqual(rig.reader.calls(), []);
  assert.deepEqual(journalledEvents(rig), ['DEPLOY_FAILED']);
  assert.equal(value.resource_manifest.provisioning_status, 'failed');
  assert.ok(codes(value.reasons).includes(code), JSON.stringify(value.reasons));
  assert.equal((await storedManifest(rig))['provisioning_status'], 'failed');
}

describe('FrozenAssemblyProvisioner frozen inputs', () => {
  it('builds nothing when the declared stack tags cannot be read, and journals why', async () => {
    const missing = await provisioningRig();
    missing.assembly_files.failRead(`${FROZEN_DIR}/manifest.json`);
    const unreadable = await missing.provisioner.provision(missing.subject);
    assert.deepEqual(unreadable.ok ? [] : codes(unreadable.error), ['DECLARED_TAGS_UNREADABLE']);
    assert.deepEqual(journalledEvents(missing), ['DEPLOY_FAILED']);
    assert.equal((await missing.package_files.read(RESOURCE_MANIFEST_PATH)).ok, false, 'no manifest frozen');

    const malformed = await provisioningRig({ manifest_tags: { 'suc:run_id': 1 } });
    const result = await malformed.provisioner.provision(malformed.subject);
    assert.deepEqual(result.ok ? [] : codes(result.error), ['DECLARED_TAGS_UNREADABLE']);
    assert.deepEqual(malformed.runner.invocations(), []);

    const invalid = await provisioningRig({ manifest_tags: { 'suc:project': 'serverless-under-constraints' } });
    const refused = await invalid.provisioner.provision(invalid.subject);
    assert.ok(!refused.ok);
    assert.ok(refused.error.length > 0 && refused.error.every((reason) => reason.subject === 'BR-RUA-050'));
    assert.deepEqual(invalid.runner.invocations(), [], 'a stack whose ownership cannot be proven is never created');
    assert.deepEqual(journalledEvents(invalid), ['DEPLOY_FAILED']);
  });

  it('keeps the unwritten DEPLOY_FAILED of unreadable tags as a reason too', async () => {
    const rig = await provisioningRig();
    rig.assembly_files.failRead(`${FROZEN_DIR}/manifest.json`);
    rig.journal_file.failWriteAt(PROVISIONING_JOURNAL_PATH, 1, 'written_unacknowledged');
    const result = await rig.provisioner.provision(rig.subject);
    assert.deepEqual(result.ok ? [] : codes(result.error), [
      'DECLARED_TAGS_UNREADABLE',
      'PROVISIONING_EVENT_NOT_WRITTEN',
    ]);
  });

  it('refuses an unreadable inventory record', async () => {
    const rig = await provisioningRig();
    rig.package_files.failReads(INVENTORY_PATH, 'IO_ERROR');
    await failedBeforeDeploy(rig, 'FROZEN_INVENTORY_UNREADABLE');
  });

  it('refuses an inventory record that is not a valid inventory', async () => {
    const rig = await provisioningRig({ inventory_bytes: new TextEncoder().encode('{"record_type":"x"}\n') });
    await failedBeforeDeploy(rig, 'RECORD_SCHEMA_INVALID');
  });

  it('refuses an inventory other than the one the execution manifest froze', async () => {
    const rig = await provisioningRig();
    const subject = {
      ...rig.subject,
      deployment_assembly: { ...rig.subject.deployment_assembly, inventory_sha256: 'f'.repeat(64) as Sha256Hex },
    };
    const value = provisioned(await rig.provisioner.provision(subject));
    assert.deepEqual(rig.runner.invocations(), []);
    assert.ok(codes(value.reasons).includes('FROZEN_INVENTORY_MISMATCH'));
    assert.equal(value.resource_manifest.provisioning_status, 'failed');
  });

  it('refuses a template outside the frozen assembly, unreadable, or not the frozen bytes', async () => {
    const outside = await provisioningRig();
    const outsideSubject = {
      ...outside.subject,
      deployment_assembly: {
        ...outside.subject.deployment_assembly,
        template_path: `admission/${RUN_STACK}.template.json`,
      },
    };
    const refused = provisioned(await outside.provisioner.provision(outsideSubject));
    assert.ok(codes(refused.reasons).includes('FROZEN_TEMPLATE_OUTSIDE_ASSEMBLY'));
    assert.deepEqual(outside.runner.invocations(), []);

    const unreadable = await provisioningRig();
    unreadable.assembly_files.failRead(TEMPLATE_PATH);
    await failedBeforeDeploy(unreadable, 'FROZEN_TEMPLATE_UNREADABLE');

    const altered = await provisioningRig();
    const alteredSubject = {
      ...altered.subject,
      deployment_assembly: { ...altered.subject.deployment_assembly, template_sha256: '0'.repeat(64) as Sha256Hex },
    };
    const mismatch = provisioned(await altered.provisioner.provision(alteredSubject));
    assert.ok(codes(mismatch.reasons).includes('FROZEN_TEMPLATE_MISMATCH'));
    assert.deepEqual(altered.runner.invocations(), []);
  });

  it('refuses a template the post-deploy reads cannot be planned from', async () => {
    const template = runTemplate();
    removeResource(template, FIXTURE_IDS.providerVersion);
    const rig = await provisioningRig({ template });
    const value = provisioned(await rig.provisioner.provision(rig.subject));
    assert.deepEqual(rig.runner.invocations(), []);
    assert.equal(value.resource_manifest.provisioning_status, 'failed');
    assert.ok(codes(value.reasons).includes('TEMPLATE_RESOURCE_MISSING'), JSON.stringify(value.reasons));
  });

  it('keeps an unwritten DEPLOY_FAILED of a refused copy as a reason', async () => {
    const rig = await provisioningRig();
    rig.package_files.failReads(INVENTORY_PATH, 'IO_ERROR');
    rig.journal_file.failWriteAt(PROVISIONING_JOURNAL_PATH, 1, 'written_unacknowledged');
    const value = provisioned(await rig.provisioner.provision(rig.subject));
    assert.ok(codes(value.reasons).includes('PROVISIONING_EVENT_NOT_WRITTEN'));
  });
});

describe('FrozenAssemblyProvisioner reads and writes', () => {
  it('lists the resources by stack name when DescribeStacks fails', async () => {
    const rig = await provisioningRig();
    rig.reader.failWith('describeStack', { code: 'Throttling', detail: 'Rate exceeded' });
    const value = provisioned(await rig.provisioner.provision(rig.subject));
    assert.deepEqual(rig.reader.calls()[1], { method: 'listStackResources', args: [RUN_STACK] });
    assert.ok(codes(value.reasons).includes('STACK_READ_FAILED'));
    assert.ok(codes(value.reasons).includes('STACK_NOT_DESCRIBED'));
    assert.equal(value.resource_manifest.provisioning_status, 'partial');
    assert.equal(value.resource_manifest.stack_id, undefined);
    assert.ok(!journalledEvents(rig).includes('STACK_ID_RECORDED'));
  });

  it('freezes a failed manifest without configuration when the resources cannot be listed', async () => {
    const rig = await provisioningRig();
    rig.reader.failWith('listStackResources', { code: 'Throttling', detail: 'Rate exceeded' });
    const value = provisioned(await rig.provisioner.provision(rig.subject));
    assert.deepEqual(
      rig.reader.calls().map((call) => call.method),
      ['describeStack', 'listStackResources'],
    );
    assert.ok(codes(value.reasons).includes('STACK_READ_FAILED'));
    assert.ok(codes(value.reasons).includes('RESOURCES_NOT_LISTED'));
    assert.equal(value.resource_manifest.provisioning_status, 'failed');
    assert.equal(value.resource_manifest.stack_id, stackIdOf(RUN_STACK));
  });

  it('reports a failed configuration read and an unresolvable read target', async () => {
    const rig = await provisioningRig();
    rig.reader.failWith('readTable', { code: 'ResourceNotFoundException', detail: 'gone' });
    const queue = rig.account.resources.find(
      (resource) => resource['LogicalResourceId'] === FIXTURE_IDS.controllerFailure,
    );
    assert.ok(queue !== undefined);
    queue['PhysicalResourceId'] = 'not-a-queue-url';
    const value = provisioned(await rig.provisioner.provision(rig.subject));
    assert.deepEqual(codes(value.reasons).toSorted(), ['CONFIGURATION_READ_FAILED', 'READ_TARGET_UNRESOLVED']);
    assert.equal(value.resource_manifest.provisioning_status, 'partial');
  });

  it('turns every unwritten journal event into a reason and never succeeds', async () => {
    const rig = await provisioningRig();
    rig.journal_file.failWriteAt(PROVISIONING_JOURNAL_PATH, 1, 'written_unacknowledged');
    const value = provisioned(await rig.provisioner.provision(rig.subject));
    assert.deepEqual(
      codes(value.reasons),
      Array.from({ length: 5 }, () => 'PROVISIONING_EVENT_NOT_WRITTEN'),
    );
    assert.equal(rig.runner.invocations().length, 1, 'the deployment itself still ran');
    assert.equal(value.resource_manifest.provisioning_status, 'partial');
  });

  it('reports an unreadable package copy after the deployment (D3)', async () => {
    const rig = await provisioningRig();
    await rig.assembly_files.createFile(`${FROZEN_DIR}/late.txt`, new Uint8Array([1]), 0o644);
    rig.assembly_files.failRead(`${FROZEN_DIR}/late.txt`);
    const value = provisioned(await rig.provisioner.provision(rig.subject));
    assert.equal(rig.runner.invocations().length, 1, 'the copy holds only inventoried files and deploys');
    assert.deepEqual(codes(value.reasons), ['ASSEMBLY_UNREADABLE']);
    assert.ok(!journalledEvents(rig).includes('PACKAGE_ASSEMBLY_REVERIFIED'));
  });

  it('reports a manifest file that already exists and keeps the digest of the bytes it froze', async () => {
    const rig = await provisioningRig();
    await rig.package_files.writeOnce(RESOURCE_MANIFEST_PATH, new Uint8Array([123, 125]));
    const value = provisioned(await rig.provisioner.provision(rig.subject));
    assert.deepEqual(codes(value.reasons), ['RESOURCE_MANIFEST_NOT_WRITTEN']);
    assert.match(value.resource_manifest_sha256, /^[0-9a-f]{64}$/);
  });

  it('freezes nothing when the manifest fails its schema', async () => {
    const fileSystem = new InMemorySchemaFileSystem()
      .writeFile(join(SCHEMA_ROOT, '_defs.schema.json'), readFileSync(join(SCHEMA_ROOT, '_defs.schema.json')))
      .writeFile(
        join(SCHEMA_ROOT, 'group-a/deployment_assembly_inventory.schema.json'),
        readFileSync(join(SCHEMA_ROOT, 'group-a/deployment_assembly_inventory.schema.json')),
      );
    const rig = await provisioningRig({ validator: createRecordValidator({ schemaRoot: SCHEMA_ROOT, fileSystem }) });
    const result = await rig.provisioner.provision(rig.subject);
    assert.ok(!result.ok);
    assert.deepEqual(codes(result.error), ['RESOURCE_MANIFEST_INVALID']);
    assert.match(result.error[0]?.detail ?? '', /no schema at/);
    assert.equal((await rig.package_files.read(RESOURCE_MANIFEST_PATH)).ok, false);
  });
});
