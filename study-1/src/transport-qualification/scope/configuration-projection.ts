// Configuration projections of the transport scope (BR-RUA-028): for one policy projection,
// the normalized values of its property paths on every selected template resource.
//
// Each selected resource contributes one entry listing every declared property path, in policy
// order, with the canonical JSON text of its normalized value. The text form keeps CloudFormation
// member names (`StreamViewType`, `Fn::GetAtt`) out of the record's property names (BR-RUA-033).
// The text is omitted when the resource does not set the property: an absent property is
// configuration too (for example "no reserved concurrency"), so setting it later is drift.
//
// Resource identity is kept (WP-11 review round 1): the entries are ordered by each resource's
// stack-relative construct path, which is the same for every execution, and a reference names
// the referenced resource's construct path (cfn-value-normalization.ts). Swapping the provider's
// and the controller's settings, or moving a grant from one table to another, therefore changes
// the projection. Logical ids are never used: their hash suffixes vary with the execution.
//
// Selection needs the `aws:cdk:path` metadata (see cfn-template.ts). A resource of the
// projection's type without it cannot be placed inside or outside the selector, so the
// projection is refused instead of silently leaving that resource out of the scope.

import { canonicalJson, canonicalJsonIfRepresentable } from '../../record-contract/canonical-json.ts';
import { boundedJsonText } from '../../record-contract/json-value.ts';
import type { JsonObject, Result, StructuredReason } from '../../record-contract/primitives.ts';
import type { ConfigurationProjectionPolicy } from '../../record-contract/records/group-a/transport_scope_policy.ts';
import type {
  ProjectedProperty,
  ProjectedResource,
} from '../../record-contract/records/group-a/transport_scope_snapshot.ts';
import { compareCodeUnits } from './bundle-inputs.ts';
import type { CfnTemplate, TemplateResource } from './cfn-template.ts';
import { CDK_PATH_METADATA_CONTEXT_KEY, listTemplateResources, resourceIdentity, valueAtPath } from './cfn-template.ts';
import { normalizeCfnValue } from './cfn-value-normalization.ts';
import { projectionSelector } from './scope-policy.ts';
import { scopeViolation } from './scope-reasons.ts';

/**
 * Projects and normalizes one policy projection over a template. Fails when the template is
 * malformed, when a selected value holds something JSON cannot represent (such as a non-finite
 * number), when a resource of the projection's type carries no construct-path metadata, or
 * when the projection selects no resource (a renamed construct must never drop configuration
 * from the scope silently). Total: it never throws on a schema-valid projection, however deep
 * the template's values are.
 *
 * @example
 * normalizeConfigurationProjection(template, {
 *   projection_id: 'experiment_core__functions', resource_type: 'AWS::Lambda::Function',
 *   property_paths: ['Properties.Timeout'],
 * }); // ok([{ property_values: [{ property_path: 'Properties.Timeout', canonical_json: '30' }] }, ...])
 */
export function normalizeConfigurationProjection(
  template: CfnTemplate,
  projection: ConfigurationProjectionPolicy,
): Result<readonly [ProjectedResource, ...ProjectedResource[]], StructuredReason> {
  const resources = listTemplateResources(template);
  if (!resources.ok) {
    return resources;
  }
  const ofType = resources.value.filter((resource) => resource.type === projection.resource_type);
  const unplaced = ofType.filter((resource) => !isPlaced(resource));
  if (unplaced.length > 0) {
    return { ok: false, error: withoutPathMetadata(projection, unplaced) };
  }
  const selector = projectionSelector(projection.projection_id);
  const selected = ofType
    .filter(isPlaced)
    .filter((resource) => constructPathMatches(resource.construct_path, selector));
  const references = new Map(resources.value.map((resource) => [resource.logical_id, resourceIdentity(resource)]));
  const projected: IdentifiedProjection[] = [];
  for (const resource of selected) {
    const entry = projectResource(resource, projection.property_paths, references);
    if (!entry.ok) {
      return entry;
    }
    const canonical = canonicalJson(projectedResourceJson(entry.value));
    projected.push({ identity: resourceIdentity(resource), canonical, projected: entry.value });
  }
  // Construct paths are unique in a CDK assembly; the canonical form only orders a hand-written
  // template that repeats one, so the order never depends on the template's member order.
  projected.sort((a, b) => compareCodeUnits(a.identity, b.identity) || compareCodeUnits(a.canonical, b.canonical));
  const [first, ...rest] = projected.map((entry) => entry.projected);
  if (first === undefined) {
    return {
      ok: false,
      error: scopeViolation(
        'PROJECTION_SELECTS_NOTHING',
        `projection ${projection.projection_id} selects no ${projection.resource_type} under a construct path matching ` +
          `${boundedJsonText(selector)}; expected at least one resource`,
      ),
    };
  }
  return { ok: true, value: [first, ...rest] };
}

/**
 * Tells whether a contiguous run of construct-path segments, each in snake case and joined
 * by `_`, equals the selector.
 *
 * @example
 * constructPathMatches(['ExperimentCore', 'Provider', 'Function', 'Resource'], 'provider_function'); // true
 * constructPathMatches(['ExperimentCore', 'Provider'], 'core_provider'); // false
 */
export function constructPathMatches(segments: readonly string[], selector: string): boolean {
  const snake = segments.map(snakeCaseSegment);
  return snake.some((_, start) =>
    snake.slice(start).some((_segment, offset) => snake.slice(start, start + offset + 1).join('_') === selector),
  );
}

/**
 * The snake-case form of one construct id.
 *
 * @example
 * snakeCaseSegment('ExperimentCore'); // 'experiment_core'
 * snakeCaseSegment('StreamESMapping'); // 'stream_es_mapping'
 */
export function snakeCaseSegment(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function projectResource(
  resource: TemplateResource,
  propertyPaths: readonly [string, ...string[]],
  references: ReadonlyMap<string, string>,
): Result<ProjectedResource, StructuredReason> {
  const [firstPath, ...otherPaths] = propertyPaths;
  const first = projectProperty(resource, firstPath, references);
  if (!first.ok) {
    return first;
  }
  const others: ProjectedProperty[] = [];
  for (const path of otherPaths) {
    const other = projectProperty(resource, path, references);
    if (!other.ok) {
      return other;
    }
    others.push(other.value);
  }
  return { ok: true, value: { property_values: [first.value, ...others] } };
}

interface IdentifiedProjection {
  readonly identity: string;
  readonly canonical: string;
  readonly projected: ProjectedResource;
}

type PlacedResource = TemplateResource & { readonly construct_path: readonly string[] };

function isPlaced(resource: TemplateResource): resource is PlacedResource {
  return resource.construct_path !== undefined;
}

function withoutPathMetadata(
  projection: ConfigurationProjectionPolicy,
  unplaced: readonly TemplateResource[],
): StructuredReason {
  const logicalIds = unplaced.map((resource) => resource.logical_id);
  return scopeViolation(
    'TEMPLATE_WITHOUT_PATH_METADATA',
    `projection ${projection.projection_id}: ${projection.resource_type} resources ${boundedJsonText(logicalIds)} carry no ` +
      `string Metadata["aws:cdk:path"]; expected a template synthesized with construct path metadata ` +
      `(the cdk synth default, or context ${CDK_PATH_METADATA_CONTEXT_KEY}=true)`,
  );
}

function projectProperty(
  resource: TemplateResource,
  path: string,
  references: ReadonlyMap<string, string>,
): Result<ProjectedProperty, StructuredReason> {
  const value = valueAtPath(resource.resource, path);
  if (value === undefined) {
    return { ok: true, value: { property_path: path } };
  }
  const canonical = canonicalJsonIfRepresentable(normalizeCfnValue(value, references));
  if (canonical === undefined) {
    return {
      ok: false,
      error: scopeViolation(
        'TEMPLATE_INVALID',
        `template Resources.${resource.logical_id}.${path} holds a value JSON cannot represent exactly, such as a ` +
          'non-finite number; expected finite JSON values only',
      ),
    };
  }
  return { ok: true, value: { property_path: path, canonical_json: canonical } };
}

/**
 * A projected resource as plain JSON, for canonical ordering and drift reports; an unset
 * property keeps only its path.
 *
 * @example
 * projectedResourceJson({ property_values: [{ property_path: 'Properties.Timeout', canonical_json: '30' }] });
 * // { property_values: [{ property_path: 'Properties.Timeout', canonical_json: '30' }] }
 */
export function projectedResourceJson(resource: ProjectedResource): JsonObject {
  return { property_values: resource.property_values.map(projectedPropertyJson) };
}

function projectedPropertyJson(property: ProjectedProperty): JsonObject {
  return property.canonical_json === undefined
    ? { property_path: property.property_path }
    : { property_path: property.property_path, canonical_json: property.canonical_json };
}
