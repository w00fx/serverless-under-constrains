// Normalization of selected CloudFormation values (BR-RUA-028 "normalized provider and
// controller configuration"): strips everything that identifies one execution rather than
// configuring the transport, so a probe stack and a later run stack with the same transport
// configuration project to identical values.
//
// - Tags and physical-name keys are dropped (BR-RUA-050 names and tags carry the execution).
// - A `Ref` or `Fn::GetAtt` to a template resource names the resource type instead of the
//   logical id; pseudo parameters and template parameters keep their names.
// - A string that is an ARN becomes `<arn>`; UUIDs (execution ids) become `<uuid>`; the
//   execution prefix of run-owned names (`suc1-<p>-`, `SucRua-<kind>-<p>`, see
//   `infra/ownership/resource-naming.ts`) becomes a placeholder.

import { isJsonArray, isJsonObject } from '../../record-contract/json-value.ts';
import type { JsonObject, JsonValue } from '../../record-contract/primitives.ts';

export const STRIPPED_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  'Tags',
  'FunctionName',
  'TableName',
  'RoleName',
  'QueueName',
  'LogGroupName',
  'PolicyName',
  'ManagedPolicyName',
  'TopicName',
  'BucketName',
  'StreamName',
]);

const ARN_PREFIX = 'arn:';
const UUID_PATTERN = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const RESOURCE_PREFIX_PATTERN = /suc1-[0-9a-f]{8}-/g;
const STACK_NAME_PATTERN = /SucRua-(run|probe|validation)-[0-9a-f]{8}/g;

/**
 * Normalizes one selected value; `resourceTypes` maps each template logical id to its type.
 *
 * @example
 * normalizeCfnValue({ Ref: 'LedgerTable1A2B' }, new Map([['LedgerTable1A2B', 'AWS::DynamoDB::Table']]));
 * // { Ref: '<AWS::DynamoDB::Table>' }
 */
export function normalizeCfnValue(value: JsonValue, resourceTypes: ReadonlyMap<string, string>): JsonValue {
  if (typeof value === 'string') {
    return normalizeCfnString(value);
  }
  if (isJsonArray(value)) {
    return value.map((item) => normalizeCfnValue(item, resourceTypes));
  }
  if (isJsonObject(value)) {
    return normalizeCfnObject(value, resourceTypes);
  }
  return value;
}

/**
 * Normalizes one string: ARNs, UUIDs and execution prefixes become placeholders.
 *
 * @example
 * normalizeCfnString('suc1-3f1c2a9e-ledger'); // 'suc1-<p>-ledger'
 * normalizeCfnString('arn:aws:sqs:us-east-1:123456789012:q'); // '<arn>'
 */
export function normalizeCfnString(text: string): string {
  if (text.startsWith(ARN_PREFIX)) {
    return '<arn>';
  }
  return text
    .replace(UUID_PATTERN, '<uuid>')
    .replace(RESOURCE_PREFIX_PATTERN, 'suc1-<p>-')
    .replace(STACK_NAME_PATTERN, 'SucRua-$1-<p>');
}

// Stripped keys are removed before the intrinsic check, so normalizing twice gives the same
// value: `{Tags, Ref}` and its stripped form `{Ref}` both normalize as a reference (found by
// the idempotence property, seed 164051165, counterexample {"Properties":{"Tags":"arn:aws:x","Ref":"LedgerA1B2"}}).
function normalizeCfnObject(value: JsonObject, resourceTypes: ReadonlyMap<string, string>): JsonValue {
  const keys = Object.keys(value).filter((candidate) => !STRIPPED_PROPERTY_KEYS.has(candidate));
  const ref = value['Ref'];
  if (keys.length === 1 && typeof ref === 'string') {
    return { Ref: referencedName(ref, resourceTypes) };
  }
  const getAtt = value['Fn::GetAtt'];
  if (keys.length === 1 && getAtt !== undefined) {
    return { 'Fn::GetAtt': normalizeGetAtt(getAtt, resourceTypes) };
  }
  const normalized: Record<string, JsonValue> = {};
  for (const key of keys) {
    normalized[key] = normalizeCfnValue(value[key] as JsonValue, resourceTypes);
  }
  return normalized;
}

function normalizeGetAtt(value: JsonValue, resourceTypes: ReadonlyMap<string, string>): JsonValue {
  if (!isJsonArray(value)) {
    return normalizeCfnValue(value, resourceTypes);
  }
  const [logicalId, ...attribute] = value;
  if (typeof logicalId !== 'string') {
    return normalizeCfnValue(value, resourceTypes);
  }
  return [referencedName(logicalId, resourceTypes), ...attribute.map((part) => normalizeCfnValue(part, resourceTypes))];
}

function referencedName(logicalId: string, resourceTypes: ReadonlyMap<string, string>): string {
  const type = resourceTypes.get(logicalId);
  return type === undefined ? logicalId : `<${type}>`;
}
