// Inputs of `buildResourceManifest` for a deployment that succeeded on the fixture run template
// (design §9.8 D4): a deployed report with outputs, the stack described with its id, a complete
// status and the declared tags, the recorded resources with provider version 7, and a small
// configuration snapshot. Tests override one field at a time.

import type { DeployReport } from '../../../src/deployment-assembly/assembly-ports.ts';
import type { ResourceManifestInput } from '../../../src/deployment-assembly/resource-manifest.ts';
import type { Sha256Hex, UtcMillis } from '../../../src/record-contract/primitives.ts';
import { declaredTags, RUN_IDENTITY, RUN_STACK } from './deployment-fixtures.ts';
import { FIXTURE_IDS, runTemplate } from './execution-template-fixture.ts';
import { RECORDED_STACK_ID, recordedStackResources } from './recorded-stack-resources.ts';

export const EXECUTION_MANIFEST_SHA256 = 'c'.repeat(64) as Sha256Hex;
export const RECORDED_PROVIDER_VERSION = '7';

/** A deployment report of the run stack that succeeded. */
export function deployedReport(overrides: Partial<DeployReport> = {}): DeployReport {
  return {
    stack_name: RUN_STACK,
    deployed: true,
    started_at: '2026-10-05T12:01:00.000Z' as UtcMillis,
    completed_at: '2026-10-05T12:04:00.000Z' as UtcMillis,
    outputs: [
      { key: 'ProviderFunctionName', value: 'suc1-3f1c2a9e-provider' },
      { key: 'ProviderVersion', value: RECORDED_PROVIDER_VERSION },
    ],
    reasons: [],
    ...overrides,
  };
}

/**
 * The inputs of a fully successful run provisioning, with `overrides` applied.
 *
 * @example
 * buildResourceManifest(succeededInput({ stack: undefined })); // partial, STACK_NOT_DESCRIBED
 */
export function succeededInput(overrides: Partial<ResourceManifestInput> = {}): ResourceManifestInput {
  return {
    identity: RUN_IDENTITY,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    declared_tags: declaredTags(),
    provider_version_logical_id: FIXTURE_IDS.providerVersion,
    deploy: deployedReport(),
    stack: { stack_id: RECORDED_STACK_ID, stack_status: 'CREATE_COMPLETE', tags: declaredTags() },
    resources: recordedStackResources(runTemplate(), RECORDED_PROVIDER_VERSION),
    configuration: [
      { logical_id: FIXTURE_IDS.durableMapping, attribute_path: 'BatchSize', value: 1 },
      { logical_id: FIXTURE_IDS.durableSource, attribute_path: 'VisibilityTimeout', value: 360 },
    ],
    frozen_at: '2026-10-05T12:05:00.000Z' as UtcMillis,
    ...overrides,
  };
}
