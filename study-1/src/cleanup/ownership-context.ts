// What cleanup knows about the execution when it proves ownership (BR-RUA-050): the frozen
// resource manifest (membership, ownership tags, the recorded stack, its provisioning status),
// the execution manifest's freeze time and the deterministic names of design §9.7.
//
// "Creation after manifest freeze" (BR-RUA-050, design §8.18 rule 4) is read as the execution
// manifest's freeze: BR-RUA-040 freezes it before any mutation, so every run-owned resource is
// created after it, while the resource manifest itself freezes only after provisioning.

import { executionIdOf } from '../event-journal/journal-scope.ts';
import { describeJson } from '../record-contract/json-value.ts';
import type { ExecutionIdentity, Result, StructuredReason, Uuid4, UtcMillis } from '../record-contract/primitives.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type {
  OwnershipTagEntry,
  ProvisioningStatus,
  ResourceManifest,
} from '../record-contract/records/group-a/resource_manifest.ts';
import { logGroupNamePrefix, resourceNamePrefix } from '../../infra/ownership/resource-naming.ts';
import type { ResourceTag } from './discovery.ts';
import { resourceKey } from './resource-names.ts';
import {
  EVENT_SOURCE_MAPPING_RESOURCE_TYPE,
  FUNCTION_ALIAS_RESOURCE_TYPE,
  FUNCTION_RESOURCE_TYPE,
  FUNCTION_VERSION_RESOURCE_TYPE,
  LOG_GROUP_RESOURCE_TYPE,
  QUEUE_RESOURCE_TYPE,
  ROLE_RESOURCE_TYPE,
  TABLE_RESOURCE_TYPE,
} from './resource-types.ts';

export const RUN_ID_TAG = 'suc:run_id';
export const STUDY_ID_TAG = 'suc:study_id';

/**
 * The types an execution stack creates (design §9.2): tables, functions with their published
 * versions and aliases, event-source mappings, queues, explicit log groups, roles and their
 * policies. BR-RUA-050 rule 4 accepts a resource missing from a partial manifest only with one
 * of these types or a deterministic name.
 */
export const RUN_STACK_RESOURCE_TYPES: readonly string[] = [
  TABLE_RESOURCE_TYPE,
  FUNCTION_RESOURCE_TYPE,
  FUNCTION_VERSION_RESOURCE_TYPE,
  FUNCTION_ALIAS_RESOURCE_TYPE,
  EVENT_SOURCE_MAPPING_RESOURCE_TYPE,
  QUEUE_RESOURCE_TYPE,
  LOG_GROUP_RESOURCE_TYPE,
  ROLE_RESOURCE_TYPE,
  'AWS::IAM::Policy',
];

/** Baseline and bootstrap resources, matched by canonical name; never cleaned up (BR-RUA-050). */
export interface BaselineExclusions {
  readonly names: readonly string[];
  readonly name_prefixes: readonly string[];
}

/**
 * The study's baseline: the coordination stack (design §9.1), the CDK bootstrap stack and the
 * bootstrap resources the default qualifier `hnb659fds` names (asset bucket, roles).
 */
export const STUDY_BASELINE_EXCLUSIONS: BaselineExclusions = {
  names: ['suc-study-1-coordination', 'CDKToolkit'],
  name_prefixes: ['cdk-hnb659fds-'],
};

export interface OwnershipContext {
  readonly execution_id: Uuid4;
  /** The `suc:study_id` value the resource manifest records. */
  readonly study_id: string;
  /** Every ownership tag the resource manifest records: the "exact run tags" of rule 4. */
  readonly run_tags: readonly ResourceTag[];
  readonly recorded_stack_id?: string;
  readonly provisioning_status: ProvisioningStatus;
  /** `resourceKey` of every manifest resource with a physical id. */
  readonly manifest_members: ReadonlySet<string>;
  readonly execution_manifest_frozen_at: UtcMillis;
  readonly expected_resource_types: ReadonlySet<string>;
  readonly deterministic_name_prefixes: readonly string[];
  readonly deterministic_names: readonly string[];
  readonly baseline: BaselineExclusions;
}

export interface OwnershipContextInput {
  readonly manifest: ResourceManifest;
  readonly execution: ExecutionIdentity;
  readonly execution_manifest_frozen_at: UtcMillis;
  readonly baseline: BaselineExclusions;
}

/**
 * Builds the ownership context from a validated resource manifest. Refuses a manifest of
 * another execution, or one whose `suc:run_id` and `suc:study_id` tags are not exactly one
 * each with the execution id as run id, because no ownership could then be proven.
 *
 * @example
 * const context = ownershipContextFromManifest({ manifest, execution, execution_manifest_frozen_at, baseline: STUDY_BASELINE_EXCLUSIONS });
 * if (!context.ok) return reportAmbiguous(context.error);
 */
export function ownershipContextFromManifest(input: OwnershipContextInput): Result<OwnershipContext, StructuredReason> {
  const { manifest, execution } = input;
  const executionId = executionIdOf(execution);
  const manifestId = manifestExecutionId(manifest);
  if (manifestId !== executionId) {
    return err(contextReason(`resource manifest of execution ${manifestId}; expected execution ${executionId}`));
  }
  const runId = singleTagValue(manifest.ownership_tags, RUN_ID_TAG);
  if (runId !== executionId) {
    return err(
      contextReason(`${RUN_ID_TAG} tag ${describeJson(runId)}; expected exactly one tag valued ${executionId}`),
    );
  }
  const studyId = singleTagValue(manifest.ownership_tags, STUDY_ID_TAG);
  if (studyId === undefined) {
    return err(contextReason(`${STUDY_ID_TAG} tag absent or repeated; expected exactly one tag`));
  }
  return ok({
    execution_id: executionId,
    study_id: studyId,
    run_tags: manifest.ownership_tags.map((tag) => ({ key: tag.key, value: tag.value })),
    ...(manifest.stack_id === undefined ? {} : { recorded_stack_id: manifest.stack_id }),
    provisioning_status: manifest.provisioning_status,
    manifest_members: new Set(
      manifest.resources.flatMap((entry) =>
        entry.physical_id === undefined
          ? []
          : [resourceKey({ resource_type: entry.resource_type, identifier: entry.physical_id })],
      ),
    ),
    execution_manifest_frozen_at: input.execution_manifest_frozen_at,
    expected_resource_types: new Set([
      ...RUN_STACK_RESOURCE_TYPES,
      ...manifest.resources.map((entry) => entry.resource_type),
    ]),
    deterministic_name_prefixes: [resourceNamePrefix(executionId), logGroupNamePrefix(executionId)],
    deterministic_names: [manifest.stack_name],
    baseline: input.baseline,
  });
}

function manifestExecutionId(manifest: ResourceManifest): Uuid4 {
  if ('run_id' in manifest) {
    return manifest.run_id;
  }
  return 'transport_probe_id' in manifest ? manifest.transport_probe_id : manifest.variant_validation_id;
}

function singleTagValue(tags: readonly OwnershipTagEntry[], key: string): string | undefined {
  const matching = tags.filter((tag) => tag.key === key);
  return matching.length === 1 ? matching[0]?.value : undefined;
}

function contextReason(detail: string): StructuredReason {
  return { code: 'OWNERSHIP_CONTEXT_INVALID', subject: 'BR-RUA-050', detail };
}
