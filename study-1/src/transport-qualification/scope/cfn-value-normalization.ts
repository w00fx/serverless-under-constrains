// Normalization of selected CloudFormation values (BR-RUA-028 "normalized provider and
// controller configuration"): strips everything that identifies one execution rather than
// configuring the transport, so a probe stack and a later run stack with the same transport
// configuration project to identical values.
//
// - Tags and physical-name keys are dropped (BR-RUA-050 names and tags carry the execution).
// - A `Ref` or `Fn::GetAtt` to a template resource names that resource's stable identity, its
//   stack-relative construct path (cfn-template.ts), instead of the logical id, whose hash suffix
//   can vary with the execution (`...CurrentVersion<hash>`). The identity is kept, so a grant
//   moved from one table to another is a different value (WP-11 review round 1). Pseudo
//   parameters and template parameters keep their names.
// - A string that is an ARN becomes `<arn>`; UUIDs (execution ids) become `<uuid>`; the
//   execution prefix of run-owned names (`suc1-<p>-`, `SucRua-<kind>-<p>`, see
//   `infra/ownership/resource-naming.ts`) becomes a placeholder.
//
// The walk keeps its own work list instead of recursing, so a value nested deeper than the call
// stack normalizes instead of throwing RangeError (Owner amendment A-05). It never rejects a
// leaf: a non-finite number passes through unchanged, and the projection refuses it when it
// writes the canonical form (configuration-projection.ts).

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

/** One value the walk still has to normalize, and where its normalized form goes. */
interface PendingValue {
  readonly source: JsonValue;
  readonly place: (normalized: JsonValue) => void;
  /** The operand of an `Fn::GetAtt`: a leading string is a logical id, not data. */
  readonly getAttOperand: boolean;
}

/**
 * Normalizes one selected value. `references` maps each template logical id to the stable
 * identity a reference to it carries (its stack-relative construct path, or its type when the
 * resource has no construct path). Total over every parsed JSON value, however deep.
 *
 * @example
 * normalizeCfnValue({ Ref: 'LedgerTable1A2B' }, new Map([['LedgerTable1A2B', 'ExperimentCore/LedgerTable/Resource']]));
 * // { Ref: '<ExperimentCore/LedgerTable/Resource>' }
 */
export function normalizeCfnValue(value: JsonValue, references: ReadonlyMap<string, string>): JsonValue {
  const root: { normalized: JsonValue } = { normalized: null };
  const pending: PendingValue[] = [
    {
      source: value,
      place: (normalized): void => {
        root.normalized = normalized;
      },
      getAttOperand: false,
    },
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    next.place(normalizeShallow(next, references, pending));
  }
  return root.normalized;
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

// Normalizes the value itself and schedules its members; a container is returned with
// placeholders that the scheduled members fill in.
function normalizeShallow(
  item: PendingValue,
  references: ReadonlyMap<string, string>,
  pending: PendingValue[],
): JsonValue {
  const { source } = item;
  if (typeof source === 'string') {
    return normalizeCfnString(source);
  }
  if (isJsonArray(source)) {
    return normalizeArray(source, item.getAttOperand, references, pending);
  }
  if (isJsonObject(source)) {
    return normalizeObject(source, references, pending);
  }
  return source;
}

function normalizeArray(
  source: readonly JsonValue[],
  getAttOperand: boolean,
  references: ReadonlyMap<string, string>,
  pending: PendingValue[],
): JsonValue[] {
  const normalized: JsonValue[] = [];
  source.forEach((member, index) => {
    if (index === 0 && getAttOperand && typeof member === 'string') {
      normalized.push(referencedName(member, references));
      return;
    }
    normalized.push(null);
    pending.push({
      source: member,
      place: (value) => {
        normalized[index] = value;
      },
      getAttOperand: false,
    });
  });
  return normalized;
}

// Stripped keys are removed before the intrinsic check, so normalizing twice gives the same
// value: `{Tags, Ref}` and its stripped form `{Ref}` both normalize as a reference (found by
// the idempotence property, seed 164051165, counterexample {"Properties":{"Tags":"arn:aws:x","Ref":"LedgerA1B2"}}).
function normalizeObject(
  source: JsonObject,
  references: ReadonlyMap<string, string>,
  pending: PendingValue[],
): JsonObject {
  const keys = Object.keys(source).filter((candidate) => !STRIPPED_PROPERTY_KEYS.has(candidate));
  const [onlyKey] = keys.length === 1 ? keys : [];
  const ref = source['Ref'];
  if (onlyKey === 'Ref' && typeof ref === 'string') {
    return { Ref: referencedName(ref, references) };
  }
  const normalized: Record<string, JsonValue> = {};
  for (const key of keys) {
    defineMember(normalized, key, null);
    pending.push({
      source: source[key] as JsonValue,
      place: (value) => {
        defineMember(normalized, key, value);
      },
      getAttOperand: onlyKey === 'Fn::GetAtt',
    });
  }
  return normalized;
}

// Defines an own member, so a parsed `__proto__` key stays a key instead of replacing the
// prototype of the normalized object.
function defineMember(target: Record<string, JsonValue>, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function referencedName(logicalId: string, references: ReadonlyMap<string, string>): string {
  const identity = references.get(logicalId);
  return identity === undefined ? logicalId : `<${identity}>`;
}
