// What provisioning reads back after `cdk deploy` (design §9.8 D4), checked entry by entry before
// it enters the resource manifest (BR-RUA-040, BR-RUA-053). The readings come from AWS APIs
// (DescribeStacks, ListStackResources and the post-deploy configuration reads), so each entry is
// held to the `resource_manifest` schema's shapes: an entry that does not fit is left out with a
// reason, never written, and a reason keeps the provisioning from being `succeeded`.
// - resources: CloudFormation logical id, type and status, sorted by logical id, one per id;
// - configuration: one canonical JSON text per (logical id, attribute path), sorted; two readings
//   of one attribute with different values conflict; a value JSON cannot represent is refused;
// - outputs: CloudFormation output keys with string values, one per key;
// - provider version: the number at the end of the physical id of the provider's
//   `AWS::Lambda::Version`, the immutable version every caller invokes.

import { canonicalJsonIfRepresentable } from '../record-contract/canonical-json.ts';
import { boundedJsonText } from '../record-contract/json-value.ts';
import type { JsonValue, StructuredReason } from '../record-contract/primitives.ts';
import type {
  ConfigurationAttribute,
  KeyValueEntry,
  StackResourceEntry,
} from '../record-contract/records/group-a/resource_manifest.ts';
import { deploymentReason } from './deployment-reasons.ts';

/** One stack resource as ListStackResources reports it. */
export interface StackResourceSummary {
  readonly logical_id: string;
  readonly resource_type: string;
  readonly physical_id?: string;
  readonly resource_status: string;
}

/** One attribute read after deployment, such as an event source mapping's `BatchSize`. */
export interface ConfigurationReading {
  readonly logical_id: string;
  readonly attribute_path: string;
  readonly value: JsonValue;
}

/** Checked entries and the reasons for every entry left out or found wanting. */
export interface CheckedReadings<T> {
  readonly entries: readonly T[];
  readonly reasons: readonly StructuredReason[];
}

/** The statuses of a resource that CloudFormation finished creating or updating. */
export const COMPLETE_RESOURCE_STATUSES: readonly string[] = ['CREATE_COMPLETE', 'UPDATE_COMPLETE'];

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9]+$/;
const RESOURCE_TYPE_PATTERN = /^[A-Za-z0-9]+::[A-Za-z0-9]+::[A-Za-z0-9]+$/;
const UPPER_SNAKE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const ATTRIBUTE_PATH_PATTERN = /^[A-Za-z0-9]+(\.[A-Za-z0-9]+)*$/;
const VERSION_ARN_PATTERN = /^arn:aws:lambda:[a-z0-9-]+:[0-9]{12}:function:[A-Za-z0-9_-]+:([1-9][0-9]*)$/;

/**
 * The listed resources as manifest entries, sorted by logical id; malformed or repeated entries
 * are left out and a resource that is not complete is kept, each with a reason.
 *
 * @example
 * checkStackResources([{ logical_id: 'Queue', resource_type: 'AWS::SQS::Queue', resource_status: 'CREATE_COMPLETE' }]);
 * // { entries: [...one entry...], reasons: [] }
 */
export function checkStackResources(resources: readonly StackResourceSummary[]): CheckedReadings<StackResourceEntry> {
  const kept = new Map<string, StackResourceEntry>();
  const reasons: StructuredReason[] = [];
  for (const resource of resources) {
    const problem = resourceProblem(resource, kept.has(resource.logical_id));
    if (problem === undefined) {
      kept.set(resource.logical_id, resourceEntry(resource));
    }
    reasons.push(...(problem === undefined ? incompleteResource(resource) : [problem]));
  }
  return { entries: [...kept.values()].toSorted((a, b) => (a.logical_id < b.logical_id ? -1 : 1)), reasons };
}

/**
 * The post-deploy configuration as manifest attributes, sorted by (logical id, attribute path).
 *
 * @example
 * checkConfiguration([{ logical_id: 'Mapping', attribute_path: 'BatchSize', value: 1 }]).entries[0]?.canonical_json; // '1'
 */
export function checkConfiguration(readings: readonly ConfigurationReading[]): CheckedReadings<ConfigurationAttribute> {
  const kept = new Map<string, ConfigurationAttribute>();
  const reasons: StructuredReason[] = [];
  for (const reading of readings) {
    const attribute = configurationAttribute(reading);
    const key = `${reading.logical_id}\u0000${reading.attribute_path}`;
    const problem = attribute.ok ? conflictProblem(attribute.value, kept.get(key)) : attribute.problem;
    if (attribute.ok && problem === undefined) {
      kept.set(key, attribute.value);
    }
    reasons.push(...(problem === undefined ? [] : [problem]));
  }
  const entries = [...kept.entries()].toSorted(([a], [b]) => (a < b ? -1 : 1)).map(([, value]) => value);
  return { entries, reasons };
}

/**
 * The deployment's outputs as manifest entries, one per key, in their given order.
 *
 * @example
 * checkOutputs([{ key: 'ProviderVersion', value: '7' }]); // { entries: [...], reasons: [] }
 */
export function checkOutputs(outputs: readonly KeyValueEntry[]): CheckedReadings<KeyValueEntry> {
  const kept = new Map<string, KeyValueEntry>();
  const reasons: StructuredReason[] = [];
  for (const output of outputs) {
    const valid = LOGICAL_ID_PATTERN.test(output.key) && !kept.has(output.key);
    if (valid) {
      kept.set(output.key, { key: output.key, value: output.value });
    }
    reasons.push(
      ...(valid
        ? []
        : [
            provisioningReason(
              'OUTPUT_INVALID',
              `output ${boundedJsonText(output.key)} is malformed or repeated; expected one key of letters and digits`,
            ),
          ]),
    );
  }
  return { entries: [...kept.values()], reasons };
}

/**
 * The provider's immutable version number, read from the physical id (the version ARN) of the
 * listed resource with the provider version's logical id, or the reason it is not known.
 *
 * @example
 * providerVersionNumber(entries, 'ExperimentCoreProviderFunctionCurrentVersion73'); // { version: '7', reasons: [] }
 */
export function providerVersionNumber(
  resources: readonly StackResourceEntry[],
  logicalId: string,
): { readonly version: string | undefined; readonly reasons: readonly StructuredReason[] } {
  const listed = resources.find((resource) => resource.logical_id === logicalId);
  const version =
    listed?.resource_type === 'AWS::Lambda::Version'
      ? VERSION_ARN_PATTERN.exec(listed.physical_id ?? '')?.[1]
      : undefined;
  if (version !== undefined) {
    return { version, reasons: [] };
  }
  const shown =
    listed === undefined ? 'not listed' : `${listed.resource_type} ${boundedJsonText(listed.physical_id ?? '')}`;
  return {
    version: undefined,
    reasons: [
      deploymentReason(
        'PROVIDER_VERSION_UNKNOWN',
        'BR-RUA-053',
        `provider version ${boundedJsonText(logicalId)} is ${shown}; expected an AWS::Lambda::Version whose physical id ends in its version number`,
      ),
    ],
  };
}

function resourceProblem(resource: StackResourceSummary, repeated: boolean): StructuredReason | undefined {
  const wellFormed =
    LOGICAL_ID_PATTERN.test(resource.logical_id) &&
    RESOURCE_TYPE_PATTERN.test(resource.resource_type) &&
    UPPER_SNAKE_PATTERN.test(resource.resource_status) &&
    resource.physical_id !== '';
  if (wellFormed && !repeated) {
    return undefined;
  }
  return provisioningReason(
    'RESOURCE_ENTRY_INVALID',
    `resource ${boundedJsonText(resource.logical_id)} of type ${boundedJsonText(resource.resource_type)} with status ${boundedJsonText(resource.resource_status)} is ${repeated ? 'repeated' : 'malformed'}; expected one CloudFormation logical id, type and UPPER_SNAKE status`,
  );
}

function incompleteResource(resource: StackResourceSummary): readonly StructuredReason[] {
  if (COMPLETE_RESOURCE_STATUSES.includes(resource.resource_status)) {
    return [];
  }
  return [
    provisioningReason(
      'RESOURCE_NOT_COMPLETE',
      `resource ${resource.logical_id} is ${resource.resource_status}; expected ${COMPLETE_RESOURCE_STATUSES.join(' or ')}`,
    ),
  ];
}

function resourceEntry(resource: StackResourceSummary): StackResourceEntry {
  return {
    logical_id: resource.logical_id,
    resource_type: resource.resource_type,
    ...(resource.physical_id === undefined ? {} : { physical_id: resource.physical_id }),
    resource_status: resource.resource_status,
  };
}

type AttributeCheck =
  | { readonly ok: true; readonly value: ConfigurationAttribute }
  | { readonly ok: false; readonly problem: StructuredReason };

function configurationAttribute(reading: ConfigurationReading): AttributeCheck {
  const canonical = canonicalJsonIfRepresentable(reading.value);
  const named = LOGICAL_ID_PATTERN.test(reading.logical_id) && ATTRIBUTE_PATH_PATTERN.test(reading.attribute_path);
  if (named && canonical !== undefined) {
    return {
      ok: true,
      value: { logical_id: reading.logical_id, attribute_path: reading.attribute_path, canonical_json: canonical },
    };
  }
  return {
    ok: false,
    problem: provisioningReason(
      'CONFIGURATION_ENTRY_INVALID',
      `configuration ${boundedJsonText(reading.logical_id)} ${boundedJsonText(reading.attribute_path)} is ${named ? 'not representable as JSON' : 'misnamed'}; expected a logical id, a dotted attribute path and a finite JSON value`,
    ),
  };
}

function conflictProblem(
  attribute: ConfigurationAttribute,
  earlier: ConfigurationAttribute | undefined,
): StructuredReason | undefined {
  if (earlier === undefined || earlier.canonical_json === attribute.canonical_json) {
    return undefined;
  }
  return provisioningReason(
    'CONFIGURATION_CONFLICT',
    `configuration ${attribute.logical_id} ${attribute.attribute_path} was read as ${boundedJsonText(earlier.canonical_json)} and ${boundedJsonText(attribute.canonical_json)}; expected one value`,
  );
}

function provisioningReason(code: string, detail: string): StructuredReason {
  return deploymentReason(code, 'BR-RUA-040', detail);
}
