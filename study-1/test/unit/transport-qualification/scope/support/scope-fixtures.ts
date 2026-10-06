// Shared fixtures of the transport-scope tests: a small policy, a lockfile, the bundles and
// committed files of a miniature transport project, and a CDK-shaped template whose
// execution-specific parts (stack name, execution id, logical-id hashes, tags, physical names)
// vary with the execution while its transport configuration does not.

import { serializeRecordFile } from '../../../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../../../src/record-contract/digests.ts';
import type { JsonObject, Sha256Hex } from '../../../../../src/record-contract/primitives.ts';
import type { ScopeTimingValues } from '../../../../../src/record-contract/records/group-a/transport_scope_snapshot.ts';
import type { TransportScopePolicy } from '../../../../../src/record-contract/records/group-a/transport_scope_policy.ts';
import type { BundleInputs } from '../../../../../src/transport-qualification/scope/bundle-inputs.ts';
import type { LoadedScopePolicy } from '../../../../../src/transport-qualification/scope/scope-policy.ts';
import type { ScopeSnapshotInput } from '../../../../../src/transport-qualification/scope/scope-snapshot.ts';
import { parsePackageLock } from '../../../../../src/transport-qualification/scope/package-lock.ts';

export const PROBE_HANDLER = 'src/transport-probe-caller/transport-probe-caller.handler.ts';
export const PROVIDER_HANDLER = 'src/refund-provider/refund-provider.handler.ts';
export const CLIENT_SOURCE = 'src/provider-client/provider-client.ts';
export const CLIENT_TIMING_FILE = 'src/provider-client/timing.json';
export const SHARED_PRIMITIVES = 'src/record-contract/primitives.ts';
export const ORACLE_SOURCE = 'src/trial-oracle/oracle.ts';

export const SAMPLE_POLICY: TransportScopePolicy = {
  schema_version: 1,
  record_type: 'transport_scope_policy',
  entry_points: [PROBE_HANDLER, PROVIDER_HANDLER],
  source_roots: ['src/provider-client', 'src/refund-provider', 'src/transport-probe-caller'],
  configuration_projections: [
    {
      projection_id: 'experiment_core__functions',
      resource_type: 'AWS::Lambda::Function',
      property_paths: ['Properties.MemorySize', 'Properties.ReservedConcurrentExecutions', 'Properties.Timeout'],
    },
    {
      projection_id: 'experiment_core__tables',
      resource_type: 'AWS::DynamoDB::Table',
      property_paths: ['Properties.KeySchema', 'Properties.StreamSpecification'],
    },
  ],
  runtime_properties: ['bundle_format', 'bundle_target'],
  dependencies: ['@scope/declared-dep'],
};

/** The bytes the fixtures commit for a policy: its canonical record file. */
export function policyBytes(policy: TransportScopePolicy = SAMPLE_POLICY): Uint8Array {
  return serializeRecordFile(policy);
}

/** A loaded policy whose digest is that of the bytes `policyBytes` commits (BR-RUA-033). */
export function loadedPolicy(policy: TransportScopePolicy = SAMPLE_POLICY): LoadedScopePolicy {
  return { policy, policy_sha256: sha256Hex(policyBytes(policy)) };
}

export const SAMPLE_TIMING: ScopeTimingValues = {
  provider_client_deadline_ms: 3000,
  provider_safety_release_ms: 15000,
  provider_execution_timeout_ms: 30000,
  treatment_poll_interval_ms: 250,
};

export const SAMPLE_RUNTIME = { bundle_format: 'esm', bundle_target: 'node24', unrelated_property: 'ignored' } as const;

export interface LockEntryFixture {
  readonly version?: string;
  readonly resolved?: string;
  readonly integrity?: string;
  readonly dev?: boolean;
  readonly name?: string;
}

export function lockfileJson(entries: Readonly<Record<string, LockEntryFixture>>): string {
  return `${JSON.stringify({ name: 'fixture', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture' }, ...entries } }, null, 2)}\n`;
}

export function lockEntry(name: string, version: string, extra: Partial<LockEntryFixture> = {}): LockEntryFixture {
  return {
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name.replace(/^@[^/]+\//, '')}-${version}.tgz`,
    integrity: `sha512-${sha256Hex(new TextEncoder().encode(`${name}@${version}`))}`,
    ...extra,
  };
}

export const SAMPLE_LOCK_ENTRIES: Readonly<Record<string, LockEntryFixture>> = {
  'node_modules/transport-dep': lockEntry('transport-dep', '1.0.0'),
  'node_modules/transport-dep/node_modules/@inner/helper': lockEntry('@inner/helper', '2.0.0'),
  'node_modules/@scope/declared-dep': lockEntry('@scope/declared-dep', '4.1.0'),
  'node_modules/reporting-dep': lockEntry('reporting-dep', '7.0.0'),
  'node_modules/dev-only': lockEntry('dev-only', '0.1.0', { dev: true }),
};

export const SAMPLE_LOCK_BYTES = new TextEncoder().encode(lockfileJson(SAMPLE_LOCK_ENTRIES));

export function sampleLock(
  entries: Readonly<Record<string, LockEntryFixture>> = SAMPLE_LOCK_ENTRIES,
): ScopeSnapshotInput['lock'] {
  const parsed = parsePackageLock(new TextEncoder().encode(lockfileJson(entries)));
  if (!parsed.ok) {
    throw new Error(`fixture lockfile is invalid: ${parsed.error.detail}`);
  }
  return parsed.value;
}

export const SAMPLE_BUNDLES: readonly BundleInputs[] = [
  {
    entry_point: PROBE_HANDLER,
    local_sources: [CLIENT_SOURCE, SHARED_PRIMITIVES, PROBE_HANDLER],
    packages: ['node_modules/transport-dep', 'node_modules/transport-dep/node_modules/@inner/helper'],
  },
  { entry_point: PROVIDER_HANDLER, local_sources: [SHARED_PRIMITIVES, PROVIDER_HANDLER], packages: [] },
];

/** Committed project files: the transport closure, an unimported root file and an oracle module. */
export const SAMPLE_COMMITTED_FILES: Readonly<Record<string, string>> = {
  [CLIENT_SOURCE]: "export const client = 'v1';\n",
  [CLIENT_TIMING_FILE]: '{"deadline_ms":3000}\n',
  [PROBE_HANDLER]: "import { client } from '../provider-client/provider-client.ts';\n",
  [PROVIDER_HANDLER]: "export const provider = 'v1';\n",
  [SHARED_PRIMITIVES]: 'export type Shared = string;\n',
  [ORACLE_SOURCE]: "export const oracle = 'v1';\n",
};

export function digestsOf(files: Readonly<Record<string, string>>): ReadonlyMap<string, Sha256Hex> {
  const encoder = new TextEncoder();
  return new Map(Object.entries(files).map(([path, text]) => [path, sha256Hex(encoder.encode(text))]));
}

export function rootFilesOf(
  files: Readonly<Record<string, string>>,
  policy: TransportScopePolicy = SAMPLE_POLICY,
): readonly string[] {
  return Object.keys(files)
    .filter((path) => policy.source_roots.some((root) => path === root || path.startsWith(`${root}/`)))
    .sort();
}

export interface TemplateVariant {
  /** Execution id embedded in names, tags and the stack name. */
  readonly executionId?: string;
  readonly kind?: 'run' | 'probe' | 'validation';
  /** Logical-id hash suffix; CDK derives it from the construct path, stack included. */
  readonly hash?: string;
  readonly providerTimeout?: number;
  readonly providerReservedConcurrency?: number;
  readonly variantTimeout?: number;
}

/** A CDK-shaped execution-stack template with the ExperimentCore construct and one variant. */
export function cdkTemplate(variant: TemplateVariant = {}): JsonObject {
  const executionId = variant.executionId ?? '3f1c2a9e-8b4d-4c1e-9f00-1a2b3c4d5e6f';
  const prefix = executionId.slice(0, 8);
  const stack = `SucRua-${variant.kind ?? 'probe'}-${prefix}`;
  const hash = variant.hash ?? 'A1B2C3D4';
  const tags = [
    { Key: 'suc:run_id', Value: executionId },
    { Key: 'suc:study_id', Value: 'study-1' },
  ];
  const path = (suffix: string): JsonObject => ({ 'aws:cdk:path': `${stack}/${suffix}` });
  const provider: Record<string, unknown> = {
    Architectures: ['x86_64'],
    Handler: 'index.handler',
    MemorySize: 512,
    Role: { 'Fn::GetAtt': [`ExperimentCoreProviderRole${hash}`, 'Arn'] },
    Runtime: 'nodejs24.x',
    Timeout: variant.providerTimeout ?? 30,
    Environment: {
      Variables: { SUC_EXECUTION_ID: executionId, SUC_TABLE_LEDGER: { Ref: `ExperimentCoreLedger${hash}` } },
    },
    Tags: tags,
  };
  if (variant.providerReservedConcurrency !== undefined) {
    provider['ReservedConcurrentExecutions'] = variant.providerReservedConcurrency;
  }
  return {
    Resources: {
      [`ExperimentCoreProviderFunction${hash}`]: {
        Type: 'AWS::Lambda::Function',
        Properties: provider,
        Metadata: path('ExperimentCore/Provider/Function/Resource'),
      },
      [`ExperimentCoreProviderRole${hash}`]: {
        Type: 'AWS::IAM::Role',
        Properties: { RoleName: `suc1-${prefix}-refund-provider`, Tags: tags },
        Metadata: path('ExperimentCore/Provider/Role/Resource'),
      },
      [`ExperimentCoreControllerFunction${hash}`]: {
        Type: 'AWS::Lambda::Function',
        Properties: { MemorySize: 512, Timeout: 30, Runtime: 'nodejs24.x', Tags: tags },
        Metadata: path('ExperimentCore/Controller/Function/Resource'),
      },
      [`ExperimentCoreLedger${hash}`]: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `suc1-${prefix}-ledger`,
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'sk', KeyType: 'RANGE' },
          ],
          Tags: tags,
        },
        Metadata: path('ExperimentCore/Ledger/Resource'),
      },
      [`ExperimentCoreCallerJournal${hash}`]: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `suc1-${prefix}-caller-journal`,
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'sk', KeyType: 'RANGE' },
          ],
          StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
          Tags: tags,
        },
        Metadata: path('ExperimentCore/CallerJournal/Resource'),
      },
      [`ConventionalVariantCallerFunction${hash}`]: {
        Type: 'AWS::Lambda::Function',
        Properties: { MemorySize: 512, Timeout: variant.variantTimeout ?? 10, Runtime: 'nodejs24.x' },
        Metadata: path('ConventionalVariant/Caller/Function/Resource'),
      },
      CDKMetadata: { Type: 'AWS::CDK::Metadata', Properties: { Analytics: 'v2:deflate64:H4sI' } },
    },
    Parameters: {
      BootstrapVersion: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/cdk-bootstrap/hnb659fds/version' },
    },
  } as JsonObject;
}

/** The complete input of `computeScopeSnapshot` for the miniature project. */
export function sampleSnapshotInput(overrides: Partial<ScopeSnapshotInput> = {}): ScopeSnapshotInput {
  return {
    policy: loadedPolicy(),
    bundles: SAMPLE_BUNDLES,
    committed_files: rootFilesOf(SAMPLE_COMMITTED_FILES),
    source_digests: digestsOf(SAMPLE_COMMITTED_FILES),
    lock: sampleLock(),
    template: cdkTemplate(),
    runtime: SAMPLE_RUNTIME,
    timing: SAMPLE_TIMING,
    provider_warmup: { invocations_per_trial: 1 },
    ...overrides,
  };
}
