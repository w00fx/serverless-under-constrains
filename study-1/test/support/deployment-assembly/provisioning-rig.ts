// The provisioning rig (design §9.8 D1-D4, §12.2): one admitted run package in memory and the
// production FrozenAssemblyProvisioner over it. The frozen assembly holds a cloud-assembly
// manifest declaring the stack's ownership tags, the execution template and asset files, inventoried
// exactly as admission freezes it; the package holds that inventory record. Deployment runs the
// production CdkAssemblyDeployer over the FakeCommandRunner, and the post-deploy reads answer from a
// DeployedAccount through the FakePostDeployReader. Tests change the parts before provisioning.
// `synthesized_assembly_dir` replaces the fixture assembly with a cloud assembly the study app
// synthesized to disk, so AC-RUA-053 is also proved on the stack the study actually deploys.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { CdkAssemblyDeployer } from '../../../src/deployment-assembly/cdk-assembly-deployer.ts';
import { FrozenAssemblyProvisioner } from '../../../src/deployment-assembly/frozen-assembly-provisioner.ts';
import type {
  FrozenAssemblyProvisionerDeps,
  ProvisioningSubject,
} from '../../../src/deployment-assembly/frozen-assembly-provisioner.ts';
import { readAssemblyListing } from '../../../src/deployment-assembly/assembly-listing.ts';
import { inventoryAssembly } from '../../../src/evidence-package/assembly-inventory.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonObject, JsonValue, Sha256Hex } from '../../../src/record-contract/primitives.ts';
import type { DeploymentAssemblyInventory } from '../../../src/record-contract/records/group-a/deployment_assembly_inventory.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { MemoryAppendOnlyFile } from '../event-journal/memory-append-only-file.ts';
import { MemoryPackageFileSystem } from '../evidence-package/memory-package-file-system.ts';
import { SequentialUuidSource } from '../kernel/sequential-uuid-source.ts';
import { deployedAccount, stackIdOf } from './deployed-account.ts';
import type { DeployedAccount } from './deployed-account.ts';
import {
  ADMITTED_AT,
  declaredTags,
  EXECUTION_ID,
  MEMORY_TOOLS,
  RUN_IDENTITY,
  RUN_STACK,
  SteppingWallClock,
} from './deployment-fixtures.ts';
import { runTemplate, templateBytes } from './execution-template-fixture.ts';
import { FakeCommandRunner } from './fake-command-runner.ts';
import { FakePostDeployReader } from './fake-post-deploy-reader.ts';
import { MemoryAssemblyFileSystem } from './memory-assembly-file-system.ts';

export const EVIDENCE_ROOT = '/work/evidence';
export const DEPLOY_STAGING_ROOT = '/study/.deploy-staging';
export const PACKAGE_DIRECTORY = `runs/${EXECUTION_ID}`;
export const FROZEN_ASSEMBLY = 'admission/deployment-assembly';
export const FROZEN_DIR = `${EVIDENCE_ROOT}/${PACKAGE_DIRECTORY}/${FROZEN_ASSEMBLY}`;
export const COPY_DIR = `${DEPLOY_STAGING_ROOT}/${EXECUTION_ID}`;
export const EXECUTION_MANIFEST_SHA = 'e'.repeat(64) as Sha256Hex;
export const RESOURCE_MANIFEST_PATH = `${PACKAGE_DIRECTORY}/${EXECUTION_PATHS.resourceManifest}`;
export const PROVISIONING_JOURNAL_PATH = `${PACKAGE_DIRECTORY}/${EXECUTION_PATHS.provisioningJournal}`;
const TEMPLATE_FILE = `${RUN_STACK}.template.json`;
export const DEPLOYED_OUTPUTS = `{"${RUN_STACK}":{"ProviderVersion":"7","ControllerFunctionName":"suc1-3f1c2a9e-controller"}}`;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What a test may change before the rig is built. */
export interface ProvisioningRigOptions {
  readonly template?: JsonObject;
  /** The cloud-assembly manifest's `tags` member of the stack; the declared tags by default. */
  readonly manifest_tags?: JsonValue;
  readonly deploy_staging_root?: string;
  readonly validator?: FrozenAssemblyProvisionerDeps['validator'];
  /** The stored inventory record's bytes; the canonical record by default. */
  readonly inventory_bytes?: Uint8Array;
  /** A run cloud assembly synthesized to disk; its files, modes and template replace the fixture's. */
  readonly synthesized_assembly_dir?: string;
}

interface FrozenTemplate {
  readonly template: JsonObject;
  readonly bytes: Uint8Array;
}

export interface ProvisioningRig {
  readonly assembly_files: MemoryAssemblyFileSystem;
  readonly package_files: MemoryPackageFileSystem;
  readonly journal_file: MemoryAppendOnlyFile;
  readonly runner: FakeCommandRunner;
  readonly account: DeployedAccount;
  readonly reader: FakePostDeployReader;
  readonly inventory: DeploymentAssemblyInventory;
  readonly subject: ProvisioningSubject;
  readonly provisioner: FrozenAssemblyProvisioner;
}

/**
 * A run admitted with `template`, ready to provision.
 *
 * @example
 * const rig = await provisioningRig();
 * const provisioned = await rig.provisioner.provision(rig.subject);
 */
export async function provisioningRig(options: ProvisioningRigOptions = {}): Promise<ProvisioningRig> {
  const assembly_files = new MemoryAssemblyFileSystem();
  const { template, bytes } =
    options.synthesized_assembly_dir === undefined
      ? await placeFixtureAssembly(assembly_files, options)
      : await placeSynthesizedAssembly(assembly_files, options.synthesized_assembly_dir);
  const inventory = await inventoryOf(assembly_files);
  const package_files = new MemoryPackageFileSystem();
  await package_files.writeOnce(
    `${PACKAGE_DIRECTORY}/${EXECUTION_PATHS.deploymentAssemblyInventory}`,
    options.inventory_bytes ?? serializeRecordFile(inventory),
  );
  const runner = new FakeCommandRunner(assembly_files);
  runner.scriptDeployOutputs(DEPLOYED_OUTPUTS);
  const account = deployedAccount(template, RUN_STACK, stackIdOf(RUN_STACK), declaredTags());
  const reader = new FakePostDeployReader(account);
  const journal_file = new MemoryAppendOnlyFile();
  const clock = new SteppingWallClock();
  const provisioner = new FrozenAssemblyProvisioner({
    assembly_files,
    package_files,
    journal_file,
    deployer: new CdkAssemblyDeployer({ runner, files: assembly_files, tools: MEMORY_TOOLS, clock }),
    reader,
    validator: options.validator ?? createRecordValidator(),
    clock,
    ids: new SequentialUuidSource('0000000b'),
    evidence_root: EVIDENCE_ROOT,
    deploy_staging_root: options.deploy_staging_root ?? DEPLOY_STAGING_ROOT,
  });
  const subject: ProvisioningSubject = {
    identity: RUN_IDENTITY,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA,
    deployment_assembly: {
      assembly_path: FROZEN_ASSEMBLY,
      inventory_sha256: inventory.inventory_sha256,
      template_path: `${FROZEN_ASSEMBLY}/${TEMPLATE_FILE}`,
      template_sha256: sha256Hex(bytes),
    },
    package_directory: PACKAGE_DIRECTORY,
  };
  return { assembly_files, package_files, journal_file, runner, account, reader, inventory, subject, provisioner };
}

/**
 * The provisioning events journalled so far, in order.
 *
 * @example
 * journalledEvents(rig); // ['DEPLOY_COPY_VERIFIED', 'DEPLOY_STARTED', ...]
 */
export function journalledEvents(rig: ProvisioningRig): readonly string[] {
  return journalLines(rig).map((line) => {
    const event = line['provisioning_event'];
    return typeof event === 'string' ? event : JSON.stringify(event);
  });
}

/**
 * The journal lines written so far, parsed.
 *
 * @example
 * journalLines(rig)[0]?.['inventory_sha256'];
 */
export function journalLines(rig: ProvisioningRig): readonly Readonly<Record<string, JsonValue>>[] {
  const text = rig.journal_file.text(PROVISIONING_JOURNAL_PATH) ?? '';
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Readonly<Record<string, JsonValue>>);
}

/**
 * The stored resource-manifest bytes; throws when none was written.
 *
 * @example
 * sha256Hex(await storedManifestBytes(rig));
 */
export async function storedManifestBytes(rig: ProvisioningRig): Promise<Uint8Array> {
  const stored = await rig.package_files.read(RESOURCE_MANIFEST_PATH);
  if (!stored.ok) {
    throw new Error(`no resource manifest at ${RESOURCE_MANIFEST_PATH}: ${stored.error.code}; expected one written`);
  }
  return stored.value;
}

/**
 * The stored resource manifest, parsed.
 *
 * @example
 * (await storedManifest(rig))['provisioning_status']; // 'succeeded'
 */
export async function storedManifest(rig: ProvisioningRig): Promise<Readonly<Record<string, JsonValue>>> {
  return JSON.parse(decoder.decode(await storedManifestBytes(rig))) as Readonly<Record<string, JsonValue>>;
}

async function placeFixtureAssembly(
  files: MemoryAssemblyFileSystem,
  options: ProvisioningRigOptions,
): Promise<FrozenTemplate> {
  const template = options.template ?? runTemplate();
  const bytes = templateBytes(template);
  await place(files, 'manifest.json', assemblyManifest(TEMPLATE_FILE, options.manifest_tags));
  await place(files, TEMPLATE_FILE, bytes);
  await place(files, `${RUN_STACK}.assets.json`, encoder.encode('{"files":{},"dockerImages":{}}'));
  await place(files, 'asset.abc123/index.mjs', encoder.encode('export const handler = () => 1;\n'));
  return { template, bytes };
}

// Every regular file below `directory`, with its permission bits, placed as admission freezes it;
// the template is the one the assembly holds, byte for byte.
async function placeSynthesizedAssembly(files: MemoryAssemblyFileSystem, directory: string): Promise<FrozenTemplate> {
  const entries = readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    await place(files, relative(directory, path), new Uint8Array(readFileSync(path)), statSync(path).mode);
  }
  const bytes = new Uint8Array(readFileSync(join(directory, TEMPLATE_FILE)));
  return { template: JSON.parse(decoder.decode(bytes)) as JsonObject, bytes };
}

function assemblyManifest(templateFile: string, tags: JsonValue | undefined): Uint8Array {
  const declared = Object.fromEntries(declaredTags().map((tag) => [tag.key, tag.value]));
  return encoder.encode(
    JSON.stringify({
      version: '54.0.0',
      artifacts: {
        [RUN_STACK]: {
          type: 'aws:cloudformation:stack',
          environment: 'aws://123456789012/us-east-1',
          properties: { templateFile, tags: tags ?? declared },
        },
      },
    }),
  );
}

async function place(files: MemoryAssemblyFileSystem, path: string, bytes: Uint8Array, mode = 0o644): Promise<void> {
  const written = await files.createFile(join(FROZEN_DIR, path), bytes, mode);
  if (!written.ok) {
    throw new Error(`fixture write of ${path} failed: ${written.error.code}; expected a fresh memory file system`);
  }
}

async function inventoryOf(files: MemoryAssemblyFileSystem): Promise<DeploymentAssemblyInventory> {
  const listing = await readAssemblyListing(files, FROZEN_DIR);
  const inventory = listing.ok
    ? inventoryAssembly({ assembly_path: FROZEN_ASSEMBLY, ...listing.value, inventoried_at: ADMITTED_AT })
    : undefined;
  if (inventory?.ok !== true) {
    throw new Error(`fixture assembly could not be inventoried: ${JSON.stringify(inventory ?? listing)}`);
  }
  return inventory.value;
}
