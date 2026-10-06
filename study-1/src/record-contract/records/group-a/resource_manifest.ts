// `resource_manifest` (BR-RUA-040, BR-RUA-050): the frozen result of provisioning. Trials start
// only after a `succeeded` manifest, which always names the stack id and provider version.

import type { ExecutionIdentityFields } from '../../envelope.ts';
import type { Sha256Hex, UtcMillis } from '../../primitives.ts';

export const PROVISIONING_STATUSES = ['succeeded', 'partial', 'failed'] as const;
export type ProvisioningStatus = (typeof PROVISIONING_STATUSES)[number];

export interface StackResourceEntry {
  readonly logical_id: string;
  readonly resource_type: string;
  /** Omitted when CloudFormation never assigned one. */
  readonly physical_id?: string;
  /** CloudFormation status, for example `CREATE_COMPLETE`. */
  readonly resource_status: string;
}

/** A tag or output as a key/value pair: their keys are not snake_case property names. */
export interface KeyValueEntry {
  readonly key: string;
  readonly value: string;
}

/**
 * One attribute of the post-deploy configuration snapshot, for example the `BatchSize` of an
 * event source mapping. The value is the canonical JSON text of what the AWS API returned,
 * because AWS member names are not BR-RUA-033 property names.
 */
export interface ConfigurationAttribute {
  readonly logical_id: string;
  readonly attribute_path: string;
  readonly canonical_json: string;
}

interface ResourceManifestFields {
  readonly schema_version: 1;
  readonly record_type: 'resource_manifest';
  readonly execution_manifest_sha256: Sha256Hex;
  /** `SucRua-<kind>-<first 8 hex digits of the execution id>`. */
  readonly stack_name: string;
  readonly resources: readonly StackResourceEntry[];
  /** The `suc:*` ownership tags of BR-RUA-050. */
  readonly ownership_tags: readonly [KeyValueEntry, ...KeyValueEntry[]];
  readonly outputs: readonly KeyValueEntry[];
  readonly deploy_started_at: UtcMillis;
  readonly frozen_at: UtcMillis;
}

export interface SucceededProvisioning {
  readonly provisioning_status: 'succeeded';
  readonly stack_id: string;
  /** The immutable `AWS::Lambda::Version` number of the provider (BR-RUA-053). */
  readonly provider_version: string;
  /** Post-deploy configuration snapshot (ESM settings, queue attributes, table streams, tags). */
  readonly configuration: readonly [ConfigurationAttribute, ...ConfigurationAttribute[]];
  readonly deploy_completed_at: UtcMillis;
}

export interface IncompleteProvisioning {
  readonly provisioning_status: 'partial' | 'failed';
  readonly stack_id?: string;
  readonly provider_version?: string;
  readonly configuration?: readonly ConfigurationAttribute[];
  readonly deploy_completed_at?: UtcMillis;
}

export type ResourceManifest = ExecutionIdentityFields &
  ResourceManifestFields &
  (SucceededProvisioning | IncompleteProvisioning);
