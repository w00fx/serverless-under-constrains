// The production reader of the deployment projection (Owner amendment A-13; design §8.14;
// BR-RUA-007, BR-RUA-020). The run comparison of WP-16 compares, per variant, the template-derived
// values of four equality projections; this module reads them from the frozen run template, so
// every value is evidence the template states, cited by the template's path and digest:
// - `message_source_protocol`: the variant's FIFO source, dead-letter queue and SQS mapping
//   (FIFO flags, redrive count, batch size, batching window, scaling, provisioned poller, filter,
//   and whether the mapping targets an alias, a version or the unqualified function);
// - `provider_configuration`: the provider function and its published version (runtime,
//   architectures, memory, timeout, environment keys, reserved and provisioned concurrency);
// - `controller_configuration`: the controller's stream mapping and the caller-journal stream view;
// - `caller_timing`: the variant's caller function (runtime, architectures, memory, timeout) and
//   what its `SUC_PROVIDER_QUALIFIER` refers to;
// - `caller_strategy`: the variant's own execution strategy, compared within the variant only
//   (a Durable configuration's execution timeout and retention, or SQS redelivery).
// The visibility timeout, receive count, jitter and timing values come from the execution manifest
// in WP-16's sheets, so their keys never appear here. An absent property is `null`, so a property a
// template adds or drops is a difference, never silently equal.
//
// The result is structurally the `DeploymentProjection` of `src/study-comparison/equality-sheets.ts`;
// that module is on the same layer, so the type is restated and a unit test pins assignability.

import { sha256Hex } from '../record-contract/digests.ts';
import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import { boundedJsonText, isJsonObject } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type {
  JsonObject,
  JsonValue,
  Result,
  Sha256Hex,
  StructuredReason,
  VariantId,
} from '../record-contract/primitives.ts';
import { valueAtPath } from '../transport-qualification/scope/cfn-template.ts';
import type { TemplateResource } from '../transport-qualification/scope/cfn-template.ts';
import { deploymentReason } from './deployment-reasons.ts';
import {
  CORE_TEMPLATE_PATHS,
  readExecutionTemplate,
  referencedLogicalIds,
  resourceProperties,
  templateResourceAt,
  templateResourceUnder,
  variantTemplatePaths,
} from './execution-template.ts';
import type { ExecutionTemplate } from './execution-template.ts';

/** The template-derived values of one variant (WP-16 `VariantDeploymentSheet`). */
export interface VariantTemplateSheet {
  readonly message_source_protocol: JsonObject;
  readonly provider_configuration: JsonObject;
  readonly controller_configuration: JsonObject;
  readonly caller_timing: JsonObject;
  readonly caller_strategy: JsonObject;
}

/** The frozen template's projection per variant, citing the template (WP-16 `DeploymentProjection`). */
export interface DeploymentTemplateProjection {
  readonly variants: Readonly<Record<VariantId, VariantTemplateSheet>>;
  readonly evidence_refs: readonly [EvidenceRef, ...EvidenceRef[]];
}

/** The frozen template as the execution manifest pins it. */
export interface FrozenTemplateInput {
  /** Package-relative path, the manifest's `deployment_assembly.template_path`. */
  readonly template_path: string;
  readonly template_bytes: Uint8Array;
  /** The manifest's `deployment_assembly.template_sha256`. */
  readonly template_sha256: Sha256Hex;
}

interface CoreResources {
  readonly providerFunction: TemplateResource;
  readonly providerVersion: TemplateResource;
  readonly controllerMapping: TemplateResource;
  readonly callerJournalTable: TemplateResource;
}

/**
 * Reads the deployment projection of a frozen run template, or every reason it cannot.
 *
 * @example
 * const projection = projectDeploymentTemplate({ template_path, template_bytes, template_sha256 });
 * if (projection.ok) finalizeRunAssessments(records, { deployment: projection.value, ... }, sha256Hex);
 */
export function projectDeploymentTemplate(
  input: FrozenTemplateInput,
): Result<DeploymentTemplateProjection, readonly StructuredReason[]> {
  const digest = sha256Hex(input.template_bytes);
  if (digest !== input.template_sha256) {
    return err([
      projectionReason(
        'TEMPLATE_DIGEST_MISMATCH',
        `${boundedJsonText(input.template_path)} has digest ${digest}; expected the frozen ${boundedJsonText(input.template_sha256)}`,
      ),
    ]);
  }
  const template = readExecutionTemplate(input.template_bytes);
  if (!template.ok) {
    return err([template.error]);
  }
  const core = coreResources(template.value);
  if (!core.ok) {
    return core;
  }
  const conventional = variantSheet(template.value, core.value, 'conventional');
  const durable = variantSheet(template.value, core.value, 'durable');
  if (!conventional.ok || !durable.ok) {
    return err([conventional, durable].flatMap((sheet) => (sheet.ok ? [] : sheet.error)));
  }
  return ok({
    variants: { conventional: conventional.value, durable: durable.value },
    evidence_refs: [{ artifact_path: input.template_path, artifact_sha256: digest }],
  });
}

function coreResources(template: ExecutionTemplate): Result<CoreResources, readonly StructuredReason[]> {
  const found = {
    providerFunction: templateResourceAt(template, CORE_TEMPLATE_PATHS.providerFunction),
    providerVersion: templateResourceAt(template, CORE_TEMPLATE_PATHS.providerVersion),
    controllerMapping: templateResourceAt(template, CORE_TEMPLATE_PATHS.controllerMapping),
    callerJournalTable: templateResourceAt(template, CORE_TEMPLATE_PATHS.callerJournalTable),
  };
  const { providerFunction, providerVersion, controllerMapping, callerJournalTable } = found;
  if (providerFunction.ok && providerVersion.ok && controllerMapping.ok && callerJournalTable.ok) {
    return ok({
      providerFunction: providerFunction.value,
      providerVersion: providerVersion.value,
      controllerMapping: controllerMapping.value,
      callerJournalTable: callerJournalTable.value,
    });
  }
  return err(Object.values(found).flatMap((result) => (result.ok ? [] : [result.error])));
}

function variantSheet(
  template: ExecutionTemplate,
  core: CoreResources,
  variant: VariantId,
): Result<VariantTemplateSheet, readonly StructuredReason[]> {
  const paths = variantTemplatePaths(variant);
  const caller = templateResourceAt(template, paths.callerFunction);
  const source = templateResourceAt(template, paths.sourceQueue);
  const deadLetter = templateResourceAt(template, paths.deadLetterQueue);
  const mapping = templateResourceUnder(template, paths.mappingPrefix);
  if (!caller.ok || !source.ok || !deadLetter.ok || !mapping.ok) {
    return err([caller, source, deadLetter, mapping].flatMap((result) => (result.ok ? [] : [result.error])));
  }
  const callerProperties = resourceProperties(caller.value);
  return ok({
    message_source_protocol: messageSourceProtocol(template, source.value, deadLetter.value, mapping.value),
    provider_configuration: providerConfiguration(core),
    controller_configuration: controllerConfiguration(core),
    caller_timing: {
      ...functionSettings(callerProperties),
      provider_qualifier: qualifierKind(
        template,
        valueAt(callerProperties, 'Environment.Variables.SUC_PROVIDER_QUALIFIER'),
      ),
    },
    caller_strategy: callerStrategy(callerProperties),
  });
}

function messageSourceProtocol(
  template: ExecutionTemplate,
  source: TemplateResource,
  deadLetter: TemplateResource,
  mapping: TemplateResource,
): JsonObject {
  const queue = resourceProperties(source);
  const mappingProperties = resourceProperties(mapping);
  return {
    fifo: valueAt(queue, 'FifoQueue'),
    content_based_deduplication: valueAt(queue, 'ContentBasedDeduplication'),
    redrive_max_receive_count: valueAt(queue, 'RedrivePolicy.maxReceiveCount'),
    dead_letter_queue_fifo: valueAt(resourceProperties(deadLetter), 'FifoQueue'),
    batch_size: valueAt(mappingProperties, 'BatchSize'),
    maximum_batching_window_s: valueAt(mappingProperties, 'MaximumBatchingWindowInSeconds'),
    scaling_config: valueAt(mappingProperties, 'ScalingConfig'),
    provisioned_poller_config: valueAt(mappingProperties, 'ProvisionedPollerConfig'),
    filter_criteria: valueAt(mappingProperties, 'FilterCriteria'),
    target_qualifier: qualifierKind(template, valueAt(mappingProperties, 'FunctionName')),
  };
}

function providerConfiguration(core: CoreResources): JsonObject {
  const provider = resourceProperties(core.providerFunction);
  return {
    ...functionSettings(provider),
    environment_keys: environmentKeys(provider),
    reserved_concurrent_executions: valueAt(provider, 'ReservedConcurrentExecutions'),
    provisioned_concurrency_config: valueAt(resourceProperties(core.providerVersion), 'ProvisionedConcurrencyConfig'),
  };
}

function controllerConfiguration(core: CoreResources): JsonObject {
  const mapping = resourceProperties(core.controllerMapping);
  return {
    stream_view_type: valueAt(resourceProperties(core.callerJournalTable), 'StreamSpecification.StreamViewType'),
    starting_position: valueAt(mapping, 'StartingPosition'),
    batch_size: valueAt(mapping, 'BatchSize'),
    maximum_batching_window_s: valueAt(mapping, 'MaximumBatchingWindowInSeconds'),
    parallelization_factor: valueAt(mapping, 'ParallelizationFactor'),
    maximum_retry_attempts: valueAt(mapping, 'MaximumRetryAttempts'),
    maximum_record_age_s: valueAt(mapping, 'MaximumRecordAgeInSeconds'),
    bisect_batch_on_function_error: valueAt(mapping, 'BisectBatchOnFunctionError'),
    filter_criteria: valueAt(mapping, 'FilterCriteria'),
    on_failure_destination: valueAt(mapping, 'DestinationConfig.OnFailure') !== null,
  };
}

function functionSettings(properties: JsonObject): JsonObject {
  return {
    runtime: valueAt(properties, 'Runtime'),
    architectures: valueAt(properties, 'Architectures'),
    memory_size_mb: valueAt(properties, 'MemorySize'),
    timeout_s: valueAt(properties, 'Timeout'),
  };
}

// A Durable caller is configured as a durable execution; every other caller relies on SQS
// redelivery for its retry (BR-RUA-020).
function callerStrategy(properties: JsonObject): JsonObject {
  const durable = valueAt(properties, 'DurableConfig');
  if (durable === null) {
    return { execution_strategy: 'sqs_redelivery' };
  }
  return {
    execution_strategy: 'durable_step_retry',
    durable_execution_timeout_s: valueAt(properties, 'DurableConfig.ExecutionTimeout'),
    durable_retention_period_days: valueAt(properties, 'DurableConfig.RetentionPeriodInDays'),
  };
}

function environmentKeys(properties: JsonObject): JsonValue {
  const variables = valueAt(properties, 'Environment.Variables');
  return isJsonObject(variables) ? Object.keys(variables).toSorted() : null;
}

// What a function reference resolves to: a published version, an alias, or neither.
function qualifierKind(template: ExecutionTemplate, value: JsonValue): string {
  const types = referencedLogicalIds(value).map((id) => template.byLogicalId.get(id)?.type);
  if (types.includes('AWS::Lambda::Alias')) {
    return 'alias';
  }
  return types.includes('AWS::Lambda::Version') ? 'version' : 'unqualified';
}

// The own-member value at a dot-separated path, or null when any step is absent.
function valueAt(object: JsonObject, path: string): JsonValue {
  return valueAtPath(object, path) ?? null;
}

function projectionReason(code: string, detail: string): StructuredReason {
  return deploymentReason(code, 'BR-RUA-007', detail);
}
