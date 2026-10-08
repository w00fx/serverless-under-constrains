// A read model of the frozen execution template (design §9.1, §9.2; BR-RUA-042). Resources are
// found by their stack-relative construct path (`aws:cdk:path` metadata), which is the same for
// every execution of a kind, never by logical id, whose hash suffix depends on the stack name and,
// for `CurrentVersion`, on the bundled code. The paths below are the ones `infra/stacks/
// execution-stack.ts` composes; infra code may not be imported here, so the composition test
// asserts that each path exists in a real synthesized template.
//
// The template is read from frozen package bytes, so the reader is total (A-05): bytes that are
// not one JSON object, hold a non-finite number or lack the CloudFormation resource shape are
// refused with one reason. Every property read is of own members only.

import { canonicalJsonIfRepresentable } from '../record-contract/canonical-json.ts';
import { boundedJsonText, isJsonObject } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { JsonObject, JsonValue, Result, StructuredReason, VariantId } from '../record-contract/primitives.ts';
import { listTemplateResources, valueAtPath } from '../transport-qualification/scope/cfn-template.ts';
import type { TemplateResource } from '../transport-qualification/scope/cfn-template.ts';
import { deploymentReason } from './deployment-reasons.ts';

/** Construct paths of the experiment core, below the stack. */
export const CORE_TEMPLATE_PATHS = {
  providerFunction: 'ExperimentCore/Provider/Function/Resource',
  providerVersion: 'ExperimentCore/Provider/Function/CurrentVersion/Resource',
  controllerFunction: 'ExperimentCore/Controller/Function/Resource',
  controllerMapping: 'ExperimentCore/Controller/Function/CallerJournalStream/Resource',
  callerJournalTable: 'ExperimentCore/CallerJournalTable/Resource',
} as const;

/** The construct id of each variant below the stack. */
export const VARIANT_CONSTRUCT_IDS: Readonly<Record<VariantId, string>> = {
  conventional: 'ConventionalVariant',
  durable: 'DurableVariant',
};

/** Construct paths of one variant; its SQS mapping's path ends in a CDK-generated queue token. */
export interface VariantTemplatePaths {
  readonly callerFunction: string;
  readonly callerAlias: string;
  readonly sourceQueue: string;
  readonly deadLetterQueue: string;
  readonly mappingPrefix: string;
}

/** A parsed template with its resources indexed by construct path. */
export interface ExecutionTemplate {
  readonly byPath: ReadonlyMap<string, TemplateResource>;
  readonly byLogicalId: ReadonlyMap<string, TemplateResource>;
}

const RESOURCE_SUFFIX = '/Resource';
const REF_PATTERN = /"(?:Ref|Fn::GetAtt)":(?:\["|")([A-Za-z0-9]+)"/g;

/**
 * The construct paths of one variant's resources.
 *
 * @example
 * variantTemplatePaths('durable').sourceQueue; // 'DurableVariant/Source/Queue/Resource'
 */
export function variantTemplatePaths(variant: VariantId): VariantTemplatePaths {
  const id = VARIANT_CONSTRUCT_IDS[variant];
  return {
    callerFunction: `${id}/Caller/Function/Resource`,
    callerAlias: `${id}/Caller/Function/Aliaslive/Resource`,
    sourceQueue: `${id}/Source/Queue/Resource`,
    deadLetterQueue: `${id}/Source/DeadLetterQueue/Resource`,
    mappingPrefix: `${id}/Caller/Function/Aliaslive/SqsEventSource:`,
  };
}

/**
 * Parses frozen template bytes into the read model, or the reason they are not a template.
 *
 * @example
 * const template = readExecutionTemplate(templateBytes);
 * if (template.ok) templateResourceAt(template.value, CORE_TEMPLATE_PATHS.providerFunction);
 */
export function readExecutionTemplate(bytes: Uint8Array): Result<ExecutionTemplate, StructuredReason> {
  const parsed = parseJsonDocument(bytes);
  if (!parsed.ok || !isJsonObject(parsed.value) || canonicalJsonIfRepresentable(parsed.value) === undefined) {
    const shown = parsed.ok ? boundedJsonText(parsed.value) : 'not one UTF-8 JSON document';
    return err(
      templateReason('TEMPLATE_UNREADABLE', `the template is ${shown}; expected one JSON object of finite values`),
    );
  }
  const listed = listTemplateResources(parsed.value);
  if (!listed.ok) {
    return err(templateReason('TEMPLATE_UNREADABLE', listed.error.detail));
  }
  const byPath = new Map<string, TemplateResource>();
  for (const resource of listed.value) {
    if (resource.construct_path !== undefined) {
      byPath.set(resource.construct_path.join('/'), resource);
    }
  }
  return ok({ byPath, byLogicalId: new Map(listed.value.map((resource) => [resource.logical_id, resource])) });
}

/**
 * The resource at a construct path, or the reason it is missing.
 *
 * @example
 * templateResourceAt(template, CORE_TEMPLATE_PATHS.providerVersion); // { ok: true, value: { type: 'AWS::Lambda::Version', ... } }
 */
export function templateResourceAt(
  template: ExecutionTemplate,
  path: string,
): Result<TemplateResource, StructuredReason> {
  const found = template.byPath.get(path);
  if (found !== undefined) {
    return ok(found);
  }
  return err(
    templateReason(
      'TEMPLATE_RESOURCE_MISSING',
      `no resource has construct path ${boundedJsonText(path)}; expected the execution stack's resource there`,
    ),
  );
}

/**
 * The one resource whose construct path starts with `prefix` and ends in `/Resource`, such as the
 * SQS mapping of a variant, or the reason there is not exactly one.
 *
 * @example
 * templateResourceUnder(template, variantTemplatePaths('conventional').mappingPrefix);
 */
export function templateResourceUnder(
  template: ExecutionTemplate,
  prefix: string,
): Result<TemplateResource, StructuredReason> {
  const found = [...template.byPath.entries()].filter(
    ([path]) => path.startsWith(prefix) && path.endsWith(RESOURCE_SUFFIX),
  );
  const [first] = found;
  if (found.length === 1 && first !== undefined) {
    return ok(first[1]);
  }
  return err(
    templateReason(
      'TEMPLATE_RESOURCE_MISSING',
      `${String(found.length)} resources have a construct path under ${boundedJsonText(prefix)}; expected exactly one`,
    ),
  );
}

/**
 * The logical id of the provider's published version: the one `AWS::Lambda::Version` at the core's
 * `CurrentVersion` path whose `FunctionName` refers to the provider function (BR-RUA-053).
 *
 * @example
 * providerVersionLogicalId(template); // { ok: true, value: 'ExperimentCoreProviderFunctionCurrentVersion73...' }
 */
export function providerVersionLogicalId(template: ExecutionTemplate): Result<string, StructuredReason> {
  const provider = templateResourceAt(template, CORE_TEMPLATE_PATHS.providerFunction);
  if (!provider.ok) {
    return provider;
  }
  const version = templateResourceAt(template, CORE_TEMPLATE_PATHS.providerVersion);
  if (!version.ok) {
    return version;
  }
  const target = referencedLogicalIds(valueAtPath(version.value.resource, 'Properties.FunctionName') ?? null);
  const refersToProvider = target.length === 1 && target[0] === provider.value.logical_id;
  if (version.value.type !== 'AWS::Lambda::Version' || !refersToProvider) {
    return err(
      templateReason(
        'PROVIDER_VERSION_UNREADABLE',
        `${version.value.logical_id} is a ${boundedJsonText(version.value.type)} of ${boundedJsonText(target)}; expected an AWS::Lambda::Version of ${provider.value.logical_id}`,
      ),
    );
  }
  return ok(version.value.logical_id);
}

/**
 * The resource properties, or `{}` when the resource has no `Properties` object.
 *
 * @example
 * resourceProperties(resource)['Timeout']; // 30
 */
export function resourceProperties(resource: TemplateResource): JsonObject {
  const properties = valueAtPath(resource.resource, 'Properties');
  return isJsonObject(properties) ? properties : {};
}

/**
 * The logical ids a CloudFormation value refers to through `Ref` or `Fn::GetAtt`, in order of
 * appearance, read from its canonical JSON text.
 *
 * @example
 * referencedLogicalIds({ 'Fn::GetAtt': ['ProviderVersion', 'Version'] }); // ['ProviderVersion']
 */
export function referencedLogicalIds(value: JsonValue): readonly string[] {
  const text = canonicalJsonIfRepresentable(value) ?? '';
  // The pattern's one group always participates, so each match yields exactly its logical id.
  return [...text.matchAll(REF_PATTERN)].flatMap((match) => match.slice(1, 2));
}

function templateReason(code: string, detail: string): StructuredReason {
  return deploymentReason(code, 'BR-RUA-042', detail);
}
