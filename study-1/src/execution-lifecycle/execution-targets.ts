// What the deployed stack names (design §9.2 stack outputs, §9.8 D2-D4): the provider version and
// function name, each deployed variant's source queue and DLQ, the Durable caller version, the probe
// caller version, every function name telemetry looks up and the event-source mappings, read from
// the frozen resource manifest. The output keys are the ones the execution
// stack declares (`infra/stacks/execution-stack.ts` `EXECUTION_STACK_OUTPUTS`); `src` may not import
// that stack (design §5.4), so they are spelled here once and a unit test pins them to the stack's.

import { EVENT_SOURCE_MAPPING_RESOURCE_TYPE, FUNCTION_VERSION_RESOURCE_TYPE } from '../cleanup/resource-types.ts';
import { boundedJsonText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason, VariantId } from '../record-contract/primitives.ts';
import type { ResourceManifest } from '../record-contract/records/group-a/resource_manifest.ts';
import type { TelemetryFunctionRole } from '../evidence-collection/telemetry-targets.ts';
import type { ExecutionTargets, ProbeCallerOutputs, VariantQueues } from './execution-ports.ts';

/** The execution stack output keys the runner reads. */
export const STACK_OUTPUT_KEYS = {
  providerFunctionName: 'ProviderFunctionName',
  controllerFunctionName: 'ControllerFunctionName',
  probeCallerFunctionName: 'ProbeCallerFunctionName',
  probeCallerVersion: 'ProbeCallerVersion',
  conventionalCallerFunctionName: 'ConventionalCallerFunctionName',
  conventionalSourceQueueUrl: 'ConventionalSourceQueueUrl',
  conventionalDeadLetterQueueUrl: 'ConventionalDeadLetterQueueUrl',
  durableSourceQueueUrl: 'DurableSourceQueueUrl',
  durableDeadLetterQueueUrl: 'DurableDeadLetterQueueUrl',
  durableCallerFunctionName: 'DurableCallerFunctionName',
  durableCallerFunctionArn: 'DurableCallerFunctionArn',
  durableCallerAliasArn: 'DurableCallerAliasArn',
} as const;

const QUEUE_OUTPUTS: Readonly<Record<VariantId, { readonly source: string; readonly dlq: string }>> = {
  conventional: {
    source: STACK_OUTPUT_KEYS.conventionalSourceQueueUrl,
    dlq: STACK_OUTPUT_KEYS.conventionalDeadLetterQueueUrl,
  },
  durable: { source: STACK_OUTPUT_KEYS.durableSourceQueueUrl, dlq: STACK_OUTPUT_KEYS.durableDeadLetterQueueUrl },
};

// The output naming each telemetry role's deployed function (design §9.4).
const FUNCTION_NAME_OUTPUTS: Readonly<Record<TelemetryFunctionRole, string>> = {
  'conventional-caller': STACK_OUTPUT_KEYS.conventionalCallerFunctionName,
  'durable-caller': STACK_OUTPUT_KEYS.durableCallerFunctionName,
  'probe-caller': STACK_OUTPUT_KEYS.probeCallerFunctionName,
  'refund-provider': STACK_OUTPUT_KEYS.providerFunctionName,
  'treatment-controller': STACK_OUTPUT_KEYS.controllerFunctionName,
};

type Outputs = ReadonlyMap<string, string>;

// Lambda alias names: letters, digits, hyphens and underscores.
const ALIAS_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
// A Lambda published version is a positive decimal number.
const PUBLISHED_VERSION = /^[1-9][0-9]*$/;

/**
 * The targets a succeeded deploy recorded, or the first reason the manifest does not name them.
 *
 * @example
 * const targets = executionTargetsOf(resourceManifest);
 * if (targets.ok) targets.value.queues.conventional?.source.queue_name; // 'suc1-<p>-conventional-source.fifo'
 */
export function executionTargetsOf(manifest: ResourceManifest): Result<ExecutionTargets, StructuredReason> {
  if (manifest.provisioning_status !== 'succeeded') {
    return err(targetsReason(`provisioning is ${manifest.provisioning_status}; expected a succeeded deploy`));
  }
  const outputs: Outputs = new Map(manifest.outputs.map((entry) => [entry.key, entry.value]));
  const conventional = variantQueues(outputs, 'conventional');
  const durable = variantQueues(outputs, 'durable');
  const caller = durableCaller(outputs, manifest);
  const probeCaller = probeCallerOf(outputs);
  if (!conventional.ok) {
    return conventional;
  }
  if (!durable.ok) {
    return durable;
  }
  if (!caller.ok) {
    return caller;
  }
  if (!probeCaller.ok) {
    return probeCaller;
  }
  const providerFunction = outputs.get(STACK_OUTPUT_KEYS.providerFunctionName);
  return ok({
    provider_version: manifest.provider_version,
    ...(providerFunction === undefined ? {} : { provider_function_name: providerFunction }),
    ...(probeCaller.value === undefined ? {} : { probe_caller: probeCaller.value }),
    function_names: functionNames(outputs),
    queues: {
      ...(conventional.value === undefined ? {} : { conventional: conventional.value }),
      ...(durable.value === undefined ? {} : { durable: durable.value }),
    },
    ...(caller.value === undefined ? {} : { durable_caller: caller.value }),
    event_source_mapping_ids: recordedEventSourceMappings(manifest),
    durable_function_names: [outputs.get(STACK_OUTPUT_KEYS.durableCallerFunctionName) ?? []].flat(),
  });
}

/**
 * The event-source mappings the resource manifest recorded, by physical id.
 *
 * @example
 * recordedEventSourceMappings(manifest); // ['5e5e5e5e-0000-4000-8000-000000000001']
 */
export function recordedEventSourceMappings(manifest: ResourceManifest): readonly string[] {
  return manifest.resources.flatMap((resource) =>
    resource.resource_type === EVENT_SOURCE_MAPPING_RESOURCE_TYPE && resource.physical_id !== undefined
      ? [resource.physical_id]
      : [],
  );
}

/**
 * The queue name an SQS queue URL ends with.
 *
 * @example
 * queueNameOf('https://sqs.us-east-1.amazonaws.com/012345678901/suc1-3f1c2a9e-durable-dlq.fifo'); // 'suc1-3f1c2a9e-durable-dlq.fifo'
 */
export function queueNameOf(queueUrl: string): string {
  return queueUrl.slice(queueUrl.lastIndexOf('/') + 1);
}

// A variant is deployed when both of its queue outputs are present; one without the other is a
// stack that does not match the template.
function variantQueues(outputs: Outputs, variant: VariantId): Result<VariantQueues | undefined, StructuredReason> {
  const keys = QUEUE_OUTPUTS[variant];
  const source = outputs.get(keys.source);
  const dlq = outputs.get(keys.dlq);
  if (source === undefined && dlq === undefined) {
    return ok(undefined);
  }
  if (source === undefined || dlq === undefined || queueNameOf(source) === '' || queueNameOf(dlq) === '') {
    const shown = `${keys.source}=${boundedJsonText(source ?? null)}, ${keys.dlq}=${boundedJsonText(dlq ?? null)}`;
    return err(
      targetsReason(`the ${variant} queue outputs are ${shown}; expected both queue URLs, each ending in a name`),
    );
  }
  return ok({
    source: { queue_url: source, queue_name: queueNameOf(source) },
    dlq: { queue_url: dlq, queue_name: queueNameOf(dlq) },
  });
}

// The Durable caller is listed by its function ARN and the published version its alias invokes.
// `ListDurableExecutionsByFunction` refuses an alias qualifier ("Cannot filter by alias", seen in
// the first real durable validation, decision 90), so the qualifier is the one version of that
// function the resource manifest records; the alias output only proves the stack matches the
// template.
function durableCaller(
  outputs: Outputs,
  manifest: ResourceManifest,
): Result<ExecutionTargets['durable_caller'], StructuredReason> {
  const functionArn = outputs.get(STACK_OUTPUT_KEYS.durableCallerFunctionArn);
  const aliasArn = outputs.get(STACK_OUTPUT_KEYS.durableCallerAliasArn);
  if (functionArn === undefined && aliasArn === undefined) {
    return ok(undefined);
  }
  const prefix = `${functionArn ?? ''}:`;
  const alias = aliasArn?.startsWith(prefix) === true ? aliasArn.slice(prefix.length) : '';
  const versions = functionArn === undefined ? [] : recordedVersionsOf(manifest, functionArn);
  const [version] = versions;
  if (functionArn === undefined || !ALIAS_NAME_PATTERN.test(alias) || version === undefined || versions.length > 1) {
    const shown = `${boundedJsonText(functionArn ?? null)} and ${boundedJsonText(aliasArn ?? null)} with recorded versions ${boundedJsonText(versions)}`;
    return err(
      targetsReason(
        `the Durable caller outputs are ${shown}; expected a function ARN, its alias ARN <function-arn>:<alias> and exactly one recorded version <function-arn>:<n>`,
      ),
    );
  }
  return ok({ function_arn: functionArn, qualifier: version });
}

// The published versions of one function the manifest records, by their `<function-arn>:<n>` ids.
function recordedVersionsOf(manifest: ResourceManifest, functionArn: string): readonly string[] {
  const prefix = `${functionArn}:`;
  return manifest.resources.flatMap((resource) => {
    const id = resource.physical_id;
    const qualifier = id?.startsWith(prefix) === true ? id.slice(prefix.length) : '';
    return resource.resource_type === FUNCTION_VERSION_RESOURCE_TYPE && PUBLISHED_VERSION.test(qualifier)
      ? [qualifier]
      : [];
  });
}

// The probe caller is listed by its function name and the published version the runner invokes:
// one without the other, or a version that is not a positive number, is a stack that does not
// match the template (`$LATEST` or an alias is never a published version).
function probeCallerOf(outputs: Outputs): Result<ProbeCallerOutputs | undefined, StructuredReason> {
  const functionName = outputs.get(STACK_OUTPUT_KEYS.probeCallerFunctionName);
  const version = outputs.get(STACK_OUTPUT_KEYS.probeCallerVersion);
  if (functionName === undefined && version === undefined) {
    return ok(undefined);
  }
  if (functionName === undefined || functionName === '' || version === undefined || !PUBLISHED_VERSION.test(version)) {
    const shown = `${boundedJsonText(functionName ?? null)} and ${boundedJsonText(version ?? null)}`;
    return err(
      targetsReason(`the probe caller outputs are ${shown}; expected a function name and a published version number`),
    );
  }
  return ok({ function_name: functionName, version });
}

// Every telemetry role whose function the stack names.
function functionNames(outputs: Outputs): ExecutionTargets['function_names'] {
  return Object.fromEntries(
    Object.entries(FUNCTION_NAME_OUTPUTS).flatMap(([role, key]) => {
      const name = outputs.get(key);
      return name === undefined ? [] : [[role, name]];
    }),
  );
}

function targetsReason(detail: string): StructuredReason {
  return { code: 'EXECUTION_TARGETS_UNRESOLVED', subject: 'BR-RUA-040', detail };
}
