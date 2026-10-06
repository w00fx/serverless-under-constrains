// The frozen resource manifest (design §5.3 `buildResourceManifest`, §9.8 D4; BR-RUA-040,
// BR-RUA-050, BR-RUA-053). Provisioning freezes one per execution: `succeeded`, `partial` or
// `failed`, the stack name and id, every listed resource, the ownership tags, the outputs, the
// provider's immutable version and the post-deploy configuration. Trials start only on
// `succeeded`, which holds exactly when no reason was found:
// - the deployment of the expected stack `SucRua-<kind>-<p>` succeeded;
// - the stack was described with an id of that stack, a complete status and exactly the declared
//   `suc:*` ownership tags;
// - every listed resource is well formed and complete, the provider version is among them, and
//   the configuration snapshot is non-empty and consistent.
// Otherwise the manifest is `partial` when CloudFormation listed any resource and `failed` when it
// listed none, and the reasons say why (the runner journals them with the provisioning events).
// The ownership tags recorded are the ones the frozen assembly declares; a declared set that is not
// a valid BR-RUA-050 set is a caller defect and builds no manifest.

import { stackName } from '../../infra/ownership/resource-naming.ts';
import { executionIdentityFields } from '../record-contract/envelope.ts';
import { boundedJsonText } from '../record-contract/json-value.ts';
import { ok } from '../record-contract/primitives.ts';
import type {
  ExecutionIdentity,
  Result,
  Sha256Hex,
  StructuredReason,
  UtcMillis,
} from '../record-contract/primitives.ts';
import type {
  ConfigurationAttribute,
  KeyValueEntry,
  OwnershipTagEntry,
  ResourceManifest,
  StackResourceEntry,
} from '../record-contract/records/group-a/resource_manifest.ts';
import { executionIdOf } from '../evidence-package/package-layout.ts';
import type { DeployReport } from './assembly-ports.ts';
import { deploymentReason } from './deployment-reasons.ts';
import { checkDeclaredTags, observedTagReasons } from './ownership-tag-checks.ts';
import {
  checkConfiguration,
  checkOutputs,
  checkStackResources,
  providerVersionNumber,
} from './provisioning-readings.ts';
import type { ConfigurationReading, StackResourceSummary } from './provisioning-readings.ts';

/** The stack as DescribeStacks reports it after deployment. */
export interface StackDescription {
  readonly stack_id: string;
  readonly stack_status: string;
  readonly tags: readonly KeyValueEntry[];
}

export interface ResourceManifestInput {
  readonly identity: ExecutionIdentity;
  readonly execution_manifest_sha256: Sha256Hex;
  /** The `suc:*` tags the frozen assembly declares for the stack (BR-RUA-050). */
  readonly declared_tags: readonly KeyValueEntry[];
  /** The provider version's logical id in the frozen template (`providerVersionLogicalId`). */
  readonly provider_version_logical_id: string;
  readonly deploy: DeployReport;
  /** DescribeStacks after deployment; `undefined` when it failed or found no stack. */
  readonly stack: StackDescription | undefined;
  /** ListStackResources after deployment; `undefined` when it failed. */
  readonly resources: readonly StackResourceSummary[] | undefined;
  readonly configuration: readonly ConfigurationReading[];
  readonly frozen_at: UtcMillis;
}

/** The manifest to freeze and why it is not `succeeded` (empty exactly when it is). */
export interface ResourceManifestBuild {
  readonly manifest: ResourceManifest;
  readonly reasons: readonly StructuredReason[];
}

const COMPLETE_STACK_STATUSES: readonly string[] = ['CREATE_COMPLETE', 'UPDATE_COMPLETE'];
const STACK_ID_PATTERN =
  /^arn:aws:cloudformation:[a-z]{2}(-[a-z]+)+-[0-9]+:[0-9]{12}:stack\/([A-Za-z][A-Za-z0-9-]{0,127})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Builds the resource manifest of a deployment, or the reasons the declared tags are invalid.
 *
 * @example
 * const built = buildResourceManifest({ identity, execution_manifest_sha256, declared_tags, provider_version_logical_id,
 *   deploy, stack, resources, configuration, frozen_at });
 * if (built.ok && built.value.manifest.provisioning_status === 'succeeded') startTrials();
 */
export function buildResourceManifest(
  input: ResourceManifestInput,
): Result<ResourceManifestBuild, readonly StructuredReason[]> {
  const declared = checkDeclaredTags(input.identity, input.declared_tags);
  if (!declared.ok) {
    return declared;
  }
  const name = expectedStackName(input.identity);
  const stack = stackFacts(input, name, declared.value);
  const resources = checkStackResources(input.resources ?? []);
  const version = providerVersionNumber(resources.entries, input.provider_version_logical_id);
  const configuration = checkConfiguration(input.configuration);
  const outputs = checkOutputs(input.deploy.outputs);
  const reasons = [
    ...stack.reasons,
    ...(input.resources === undefined ? [notListed()] : resources.reasons),
    ...version.reasons,
    ...configuration.reasons,
    ...(configuration.entries.length === 0 ? [configurationMissing()] : []),
    ...outputs.reasons,
  ];
  const base = {
    schema_version: 1,
    record_type: 'resource_manifest',
    ...executionIdentityFields(input.identity),
    execution_manifest_sha256: input.execution_manifest_sha256,
    stack_name: name,
    resources: resources.entries,
    ownership_tags: declared.value,
    outputs: outputs.entries,
    deploy_started_at: input.deploy.started_at,
    deploy_completed_at: input.deploy.completed_at,
    frozen_at: input.frozen_at,
  } as const;
  const [first, ...rest] = configuration.entries;
  if (reasons.length === 0 && stack.stack_id !== undefined && version.version !== undefined && first !== undefined) {
    const manifest: ResourceManifest = {
      ...base,
      provisioning_status: 'succeeded',
      stack_id: stack.stack_id,
      provider_version: version.version,
      configuration: [first, ...rest],
    };
    return ok({ manifest, reasons });
  }
  return ok({
    manifest: incomplete(base, resources.entries, stack.stack_id, version.version, configuration.entries),
    reasons,
  });
}

/**
 * The stack name every execution's stack carries: `SucRua-<kind>-<first 8 hex digits>`.
 *
 * @example
 * expectedStackName({ execution_kind: 'RUN', run_id }); // 'SucRua-run-3f1c2a9e'
 */
export function expectedStackName(identity: ExecutionIdentity): string {
  return stackName(identity.execution_kind, executionIdOf(identity));
}

interface StackFacts {
  readonly stack_id: string | undefined;
  readonly reasons: readonly StructuredReason[];
}

function stackFacts(input: ResourceManifestInput, name: string, declared: readonly OwnershipTagEntry[]): StackFacts {
  const deploy = input.deploy;
  const deployReasons = [
    ...(deploy.stack_name === name
      ? []
      : [stackReason('STACK_NAME_MISMATCH', `deployed stack ${boundedJsonText(deploy.stack_name)}; expected ${name}`)]),
    ...(deploy.deployed
      ? []
      : [
          stackReason('DEPLOY_FAILED', `cdk deploy of ${name} did not succeed; expected a deployed stack`),
          ...deploy.reasons,
        ]),
  ];
  const stack = input.stack;
  if (stack === undefined) {
    return {
      stack_id: undefined,
      reasons: [
        ...deployReasons,
        stackReason('STACK_NOT_DESCRIBED', `stack ${name} was not described; expected its id, status and tags`),
      ],
    };
  }
  const idName = STACK_ID_PATTERN.exec(stack.stack_id)?.[2];
  const stackId = idName === name ? stack.stack_id : undefined;
  return {
    stack_id: stackId,
    reasons: [
      ...deployReasons,
      ...(stackId === undefined
        ? [
            stackReason(
              'STACK_ID_INVALID',
              `stack id ${boundedJsonText(stack.stack_id)}; expected the CloudFormation ARN of stack ${name}`,
            ),
          ]
        : []),
      ...(COMPLETE_STACK_STATUSES.includes(stack.stack_status)
        ? []
        : [
            stackReason(
              'STACK_NOT_COMPLETE',
              `stack ${name} is ${boundedJsonText(stack.stack_status)}; expected ${COMPLETE_STACK_STATUSES.join(' or ')}`,
            ),
          ]),
      ...observedTagReasons(declared, stack.tags),
    ],
  };
}

// Omit applied to each member of the identity union, so the identity field survives.
type ManifestBase = ResourceManifest extends infer M
  ? M extends ResourceManifest
    ? Omit<M, 'provisioning_status' | 'stack_id' | 'provider_version' | 'configuration'>
    : never
  : never;

function incomplete(
  base: ManifestBase,
  resources: readonly StackResourceEntry[],
  stackId: string | undefined,
  version: string | undefined,
  configuration: readonly ConfigurationAttribute[],
): ResourceManifest {
  return {
    ...base,
    provisioning_status: resources.length > 0 ? 'partial' : 'failed',
    ...(stackId === undefined ? {} : { stack_id: stackId }),
    ...(version === undefined ? {} : { provider_version: version }),
    ...(configuration.length === 0 ? {} : { configuration }),
  };
}

function notListed(): StructuredReason {
  return stackReason(
    'RESOURCES_NOT_LISTED',
    'the stack resources were not listed; expected ListStackResources after deployment',
  );
}

function configurationMissing(): StructuredReason {
  return stackReason(
    'CONFIGURATION_MISSING',
    'no post-deploy configuration attribute was read; expected the configuration snapshot',
  );
}

function stackReason(code: string, detail: string): StructuredReason {
  return deploymentReason(code, 'BR-RUA-040', detail);
}
