// A read model of a synthesized CloudFormation template: each resource with its logical id,
// type, properties and stack-relative CDK construct path. The construct path drops its first
// segment, the stack, because the stack name carries the execution id (design §9.1) while the
// construct tree below it is the same for every execution kind.

import { isJsonObject } from '../../record-contract/json-value.ts';
import type { JsonObject, JsonValue, Result, StructuredReason } from '../../record-contract/primitives.ts';
import { scopeViolation } from './scope-reasons.ts';

/** A synthesized template, as parsed JSON. */
export type CfnTemplate = JsonObject;

export interface TemplateResource {
  readonly logical_id: string;
  readonly type: string;
  /** Segments of `Metadata["aws:cdk:path"]` below the stack; empty when the metadata is absent. */
  readonly construct_path: readonly string[];
  readonly resource: JsonObject;
}

const CDK_PATH_METADATA = 'aws:cdk:path';

/**
 * Lists the template's resources, rejecting a template whose `Resources` section or any
 * resource lacks the CloudFormation shape.
 *
 * @example
 * const resources = listTemplateResources(JSON.parse(templateText));
 * if (resources.ok) resources.value.filter((r) => r.type === 'AWS::Lambda::Function');
 */
export function listTemplateResources(template: CfnTemplate): Result<readonly TemplateResource[], StructuredReason> {
  const resources = template['Resources'];
  if (!isJsonObject(resources)) {
    return { ok: false, error: invalidTemplate('Resources', resources, 'an object of resources') };
  }
  const listed: TemplateResource[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    const type = isJsonObject(resource) ? resource['Type'] : undefined;
    if (!isJsonObject(resource) || typeof type !== 'string') {
      return { ok: false, error: invalidTemplate(`Resources.${logicalId}`, resource, 'an object with a string Type') };
    }
    listed.push({ logical_id: logicalId, type, construct_path: constructPath(resource), resource });
  }
  return { ok: true, value: listed };
}

/**
 * The value at a dot-separated path inside a resource, or `undefined` when any segment is absent.
 *
 * @example
 * valueAtPath({ Properties: { Timeout: 30 } }, 'Properties.Timeout'); // 30
 */
export function valueAtPath(resource: JsonObject, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = resource;
  for (const segment of path.split('.')) {
    current = isJsonObject(current) ? current[segment] : undefined;
  }
  return current;
}

function constructPath(resource: JsonObject): readonly string[] {
  const metadata = resource['Metadata'];
  const path = isJsonObject(metadata) ? metadata[CDK_PATH_METADATA] : undefined;
  return typeof path === 'string' ? path.split('/').slice(1) : [];
}

function invalidTemplate(location: string, value: JsonValue | undefined, expected: string): StructuredReason {
  const found = value === undefined ? 'absent' : JSON.stringify(value);
  return scopeViolation('TEMPLATE_INVALID', `template ${location} is ${found}; expected ${expected}`);
}
