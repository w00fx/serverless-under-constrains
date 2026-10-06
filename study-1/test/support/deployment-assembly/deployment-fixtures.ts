// Shared values of the deployment-assembly tests: one execution of each kind, its synthesis
// context and declared ownership tags, the CDK tool settings of a memory file system, a wall clock
// that moves one second per reading, and the frozen inventory of an assembly directory.

import { parseExecutionSynthContext } from '../../../infra/ownership/execution-context.ts';
import type { ExecutionSynthContext } from '../../../infra/ownership/execution-context.ts';
import { readAssemblyListing } from '../../../src/deployment-assembly/assembly-listing.ts';
import type { AssemblyFileSystem } from '../../../src/deployment-assembly/assembly-file-system.ts';
import type { CdkToolSettings } from '../../../src/deployment-assembly/cdk-invocations.ts';
import { inventoryAssembly } from '../../../src/evidence-package/assembly-inventory.ts';
import type { ExecutionIdentity, UtcMillis, Uuid4, WallClock } from '../../../src/record-contract/primitives.ts';
import type { DeploymentAssemblyInventory } from '../../../src/record-contract/records/group-a/deployment_assembly_inventory.ts';
import type { KeyValueEntry } from '../../../src/record-contract/records/group-a/resource_manifest.ts';

export const EXECUTION_ID = '3f1c2a9e-8b4d-4c1e-9f00-1a2b3c4d5e6f' as Uuid4;
export const RUN_STACK = 'SucRua-run-3f1c2a9e';
export const ADMITTED_AT = '2026-10-05T12:00:00.000Z' as UtcMillis;
export const ASSEMBLY_PATH = `runs/${EXECUTION_ID}/admission/deployment-assembly`;

export const RUN_IDENTITY: ExecutionIdentity = { execution_kind: 'RUN', run_id: EXECUTION_ID };
export const PROBE_IDENTITY: ExecutionIdentity = {
  execution_kind: 'TRANSPORT_PROBE',
  transport_probe_id: EXECUTION_ID,
};
export const VALIDATION_IDENTITY: ExecutionIdentity = {
  execution_kind: 'VARIANT_VALIDATION',
  variant_validation_id: EXECUTION_ID,
};

/** The tool settings of tests on the memory file system. */
export const MEMORY_TOOLS: CdkToolSettings = {
  node_executable: '/opt/node24/bin/node',
  cdk_cli_entry: '/study/node_modules/aws-cdk/bin/cdk',
  study_root: '/study',
  docker_sentinel: '/study/tools/docker-forbidden.sh',
  environment: {
    PATH: '/usr/bin',
    HOME: '/home/operator',
    AWS_PROFILE: 'operator',
    AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    AWS_REGION: 'us-east-1',
    UNSET: undefined,
  },
};

/**
 * The synthesis context of the shared execution id for one kind (and variant).
 *
 * @example
 * synthContext('VARIANT_VALIDATION', 'durable').variant_id; // 'durable'
 */
export function synthContext(kind: ExecutionSynthContext['execution_kind'], variant?: string): ExecutionSynthContext {
  return parseExecutionSynthContext({
    execution_kind: kind,
    execution_id: EXECUTION_ID,
    account: '123456789012',
    region: 'us-east-1',
    admitted_at: ADMITTED_AT,
    total_target_ms: 600_000,
    ...(variant === undefined ? {} : { variant_id: variant }),
  });
}

/** The five `suc:*` tags every execution stack of the shared id declares. */
export function declaredTags(): KeyValueEntry[] {
  return [
    { key: 'suc:project', value: 'serverless-under-constraints' },
    { key: 'suc:study_id', value: 'study-1' },
    { key: 'suc:managed_by', value: 'rua-operator-cli' },
    { key: 'suc:run_id', value: EXECUTION_ID },
    { key: 'suc:expires_at', value: '2026-10-05T12:10:00.000Z' },
  ];
}

/** A wall clock that reads `start`, then one second later on every call. */
export class SteppingWallClock implements WallClock {
  #next: number;

  constructor(start: string = ADMITTED_AT) {
    this.#next = Date.parse(start);
  }

  now(): Date {
    const reading = new Date(this.#next);
    this.#next += 1000;
    return reading;
  }
}

/**
 * The inventory admission would freeze for `directory`; throws when it cannot be built.
 *
 * @example
 * const inventory = await frozenInventory(files, '/work/package/admission/deployment-assembly');
 */
export async function frozenInventory(
  files: AssemblyFileSystem,
  directory: string,
): Promise<DeploymentAssemblyInventory> {
  const listing = await readAssemblyListing(files, directory);
  if (!listing.ok) {
    throw new Error(`fixture assembly ${directory} unreadable: ${JSON.stringify(listing.error)}`);
  }
  const inventory = inventoryAssembly({ assembly_path: ASSEMBLY_PATH, ...listing.value, inventoried_at: ADMITTED_AT });
  if (!inventory.ok) {
    throw new Error(`fixture assembly ${directory} rejected: ${JSON.stringify(inventory.error)}`);
  }
  return inventory.value;
}

/** The files of a small frozen assembly, relative to its root. */
export const ASSEMBLY_FILES: readonly { readonly path: string; readonly text: string; readonly mode: number }[] = [
  { path: 'manifest.json', text: '{"version":"54.0.0"}', mode: 0o644 },
  { path: `${RUN_STACK}.template.json`, text: '{"Resources":{}}', mode: 0o644 },
  { path: `${RUN_STACK}.assets.json`, text: '{"files":{},"dockerImages":{}}', mode: 0o644 },
  { path: 'asset.abc123/index.mjs', text: 'export const handler = () => 1;\n', mode: 0o644 },
  { path: 'asset.abc123/run.sh', text: '#!/bin/sh\n', mode: 0o755 },
];

/**
 * Writes `ASSEMBLY_FILES` below `directory`; throws when a write fails.
 *
 * @example
 * await placeAssembly(files, '/pkg/admission/deployment-assembly');
 */
export async function placeAssembly(files: AssemblyFileSystem, directory: string): Promise<void> {
  for (const file of ASSEMBLY_FILES) {
    const written = await files.createFile(`${directory}/${file.path}`, new TextEncoder().encode(file.text), file.mode);
    if (!written.ok) {
      throw new Error(`fixture write of ${file.path} failed: ${written.error.code}`);
    }
  }
}
