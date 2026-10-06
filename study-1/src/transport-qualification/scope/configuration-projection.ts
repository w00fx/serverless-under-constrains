// Configuration projections of the transport scope (BR-RUA-028): for one policy projection,
// the normalized values of its property paths on every selected template resource.
//
// Each selected resource contributes one entry listing every declared property path, in policy
// order, with the canonical JSON text of its normalized value. The text form keeps CloudFormation
// member names (`StreamViewType`, `Fn::GetAtt`) out of the record's property names (BR-RUA-033).
// The text is omitted when the resource does not set the property: an absent property is
// configuration too (for example "no reserved concurrency"), so setting it later is drift.
// The entries are sorted by their canonical form, because the logical ids and some construct
// paths below the selector embed execution-specific hashes and cannot serve as keys.
//
// Selection needs the `aws:cdk:path` metadata (see cfn-template.ts). A resource of the
// projection's type without it cannot be placed inside or outside the selector, so the
// projection is refused instead of silently leaving that resource out of the scope.

import { canonicalJson } from '../../record-contract/canonical-json.ts';
import type { JsonObject, Result, StructuredReason } from '../../record-contract/primitives.ts';
import type { ConfigurationProjectionPolicy } from '../../record-contract/records/group-a/transport_scope_policy.ts';
import type {
  ProjectedProperty,
  ProjectedResource,
} from '../../record-contract/records/group-a/transport_scope_snapshot.ts';
import { compareCodeUnits } from './bundle-inputs.ts';
import type { CfnTemplate, TemplateResource } from './cfn-template.ts';
import { CDK_PATH_METADATA_CONTEXT_KEY, listTemplateResources, valueAtPath } from './cfn-template.ts';
import { normalizeCfnValue } from './cfn-value-normalization.ts';
import { projectionSelector } from './scope-policy.ts';
import { scopeViolation } from './scope-reasons.ts';

/**
 * Projects and normalizes one policy projection over a template. Fails when the template is
 * malformed, when a resource of the projection's type carries no construct-path metadata, or
 * when the projection selects no resource (a renamed construct must never drop configuration
 * from the scope silently). Total: it never throws on a schema-valid projection.
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
  const resourceTypes = new Map(resources.value.map((resource) => [resource.logical_id, resource.type]));
  const ofType = resources.value.filter((resource) => resource.type === projection.resource_type);
  const placed = ofType.filter(isPlaced);
  if (placed.length < ofType.length) {
    return {
      ok: false,
      error: withoutPathMetadata(
        projection,
        ofType.filter((resource) => !isPlaced(resource)),
      ),
    };
  }
  const selector = projectionSelector(projection.projection_id);
  const [first, ...rest] = sortCanonically(
    placed
      .filter((resource) => constructPathMatches(resource.construct_path, selector))
      .map((resource) => projectResource(resource, projection.property_paths, resourceTypes)),
  );
  if (first === undefined) {
    return {
      ok: false,
      error: scopeViolation(
        'PROJECTION_SELECTS_NOTHING',
        `projection ${projection.projection_id} selects no ${projection.resource_type} under a construct path matching ` +
          `${JSON.stringify(selector)}; expected at least one resource`,
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
  resourceTypes: ReadonlyMap<string, string>,
): ProjectedResource {
  const [firstPath, ...otherPaths] = propertyPaths;
  return {
    property_values: [
      projectProperty(resource, firstPath, resourceTypes),
      ...otherPaths.map((path) => projectProperty(resource, path, resourceTypes)),
    ],
  };
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
    `projection ${projection.projection_id}: ${projection.resource_type} resources ${JSON.stringify(logicalIds)} carry no ` +
      `string Metadata["aws:cdk:path"]; expected a template synthesized with construct path metadata ` +
      `(the cdk synth default, or context ${CDK_PATH_METADATA_CONTEXT_KEY}=true)`,
  );
}

function projectProperty(
  resource: TemplateResource,
  path: string,
  resourceTypes: ReadonlyMap<string, string>,
): ProjectedProperty {
  const value = valueAtPath(resource.resource, path);
  return value === undefined
    ? { property_path: path }
    : { property_path: path, canonical_json: canonicalJson(normalizeCfnValue(value, resourceTypes)) };
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

function sortCanonically(values: readonly ProjectedResource[]): readonly ProjectedResource[] {
  return values
    .map((value) => ({ value, canonical: canonicalJson(projectedResourceJson(value)) }))
    .sort((a, b) => compareCodeUnits(a.canonical, b.canonical))
    .map((entry) => entry.value);
}
