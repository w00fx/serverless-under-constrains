// A read model of a synthesized CloudFormation template: each resource with its logical id,
// type, properties and stack-relative CDK construct path. The construct path drops its first
// segment, the stack, because the stack name carries the execution id (design §9.1) while the
// construct tree below it is the same for every execution kind.
//
// The construct path comes from the `aws:cdk:path` resource metadata. The CDK CLI (`cdk synth`)
// emits it by default; a programmatic `new App()` emits it only with the context key
// `CDK_PATH_METADATA_CONTEXT_KEY` set to true. A template without it cannot be scoped.
//
// Every read is of own properties only: a policy property path may name a segment such as
// `constructor` or `toString`, which must read as absent, never as an inherited member.

import { describeJson, isJsonObject } from '../../record-contract/json-value.ts';
import type { JsonObject, JsonValue, Result, StructuredReason } from '../../record-contract/primitives.ts';
import { scopeViolation } from './scope-reasons.ts';

/** A synthesized template, as parsed JSON. */
export type CfnTemplate = JsonObject;

export interface TemplateResource {
  readonly logical_id: string;
  readonly type: string;
  /**
   * Segments of `Metadata["aws:cdk:path"]` below the stack, or `undefined` when the resource
   * carries no string construct path.
   */
  readonly construct_path: readonly string[] | undefined;
  readonly resource: JsonObject;
}

const CDK_PATH_METADATA = 'aws:cdk:path';

/**
 * The CDK context key that makes a programmatic synthesis emit `aws:cdk:path` metadata, as the
 * CDK CLI does by default. The admission synthesizer must keep it enabled.
 *
 * @example
 * new App({ outdir, context: { [CDK_PATH_METADATA_CONTEXT_KEY]: true } });
 */
export const CDK_PATH_METADATA_CONTEXT_KEY = 'aws:cdk:enable-path-metadata';

/**
 * Lists the template's resources, rejecting a template whose `Resources` section or any
 * resource lacks the CloudFormation shape.
 *
 * @example
 * const resources = listTemplateResources(JSON.parse(templateText));
 * if (resources.ok) resources.value.filter((r) => r.type === 'AWS::Lambda::Function');
 */
export function listTemplateResources(template: CfnTemplate): Result<readonly TemplateResource[], StructuredReason> {
  const resources = ownValue(template, 'Resources');
  if (!isJsonObject(resources)) {
    return { ok: false, error: invalidTemplate('Resources', resources, 'an object of resources') };
  }
  const listed: TemplateResource[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    const type = isJsonObject(resource) ? ownValue(resource, 'Type') : undefined;
    if (!isJsonObject(resource) || typeof type !== 'string') {
      return { ok: false, error: invalidTemplate(`Resources.${logicalId}`, resource, 'an object with a string Type') };
    }
    listed.push({ logical_id: logicalId, type, construct_path: constructPath(resource), resource });
  }
  return { ok: true, value: listed };
}

/**
 * The execution-independent identity of a resource: its stack-relative construct path, or its
 * type when it carries no construct path. Logical ids are not identities: CDK derives their
 * hash suffix from the whole path, stack name included, and some (`CurrentVersion<hash>`) vary
 * with the bundled code.
 *
 * @example
 * resourceIdentity({ logical_id: 'ExperimentCoreLedgerTable84EA353E', type: 'AWS::DynamoDB::Table',
 *   construct_path: ['ExperimentCore', 'LedgerTable', 'Resource'], resource: {} });
 * // 'ExperimentCore/LedgerTable/Resource'
 */
export function resourceIdentity(resource: TemplateResource): string {
  return resource.construct_path === undefined ? resource.type : resource.construct_path.join('/');
}

/**
 * The value at a dot-separated path inside a resource, or `undefined` when any segment is not
 * an own property (an inherited member such as `constructor` is absent).
 *
 * @example
 * valueAtPath({ Properties: { Timeout: 30 } }, 'Properties.Timeout'); // 30
 * valueAtPath({ Properties: {} }, 'Properties.constructor'); // undefined
 */
export function valueAtPath(resource: JsonObject, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = resource;
  for (const segment of path.split('.')) {
    current = isJsonObject(current) ? ownValue(current, segment) : undefined;
  }
  return current;
}

function ownValue(object: JsonObject, key: string): JsonValue | undefined {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function constructPath(resource: JsonObject): readonly string[] | undefined {
  const metadata = ownValue(resource, 'Metadata');
  const path = isJsonObject(metadata) ? ownValue(metadata, CDK_PATH_METADATA) : undefined;
  return typeof path === 'string' ? path.split('/').slice(1) : undefined;
}

// The kernel renderer bounds the quoted value and walks it iteratively, so a deep or huge
// malformed resource gives a short detail instead of a RangeError (Owner amendment A-05).
function invalidTemplate(location: string, value: JsonValue | undefined, expected: string): StructuredReason {
  return scopeViolation('TEMPLATE_INVALID', `template ${location} is ${describeJson(value)}; expected ${expected}`);
}
