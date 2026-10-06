// Configuration projections of the transport scope (BR-RUA-028): for one policy projection,
// the normalized values of its property paths on every selected template resource.
//
// Each selected resource contributes one object mapping every declared property path the
// resource sets to its normalized value. A path the resource does not set is omitted, never
// written as `null` (BR-RUA-033 omission rule; design §6.1 null list): an absent property is
// configuration too (for example "no reserved concurrency"), and setting it later adds a key,
// which changes the canonical bytes and is drift.
// The objects are sorted by their canonical form, because the logical ids and some construct
// paths below the selector embed execution-specific hashes and cannot serve as keys.
//
// Selection needs the `aws:cdk:path` metadata (see cfn-template.ts). A resource of the
// projection's type without it cannot be placed inside or outside the selector, so the
// projection is refused instead of silently leaving that resource out of the scope.

import { canonicalJson } from '../../record-contract/canonical-json.ts';
import type { JsonObject, JsonValue, Result, StructuredReason } from '../../record-contract/primitives.ts';
import type { ConfigurationProjectionPolicy } from '../../record-contract/records/group-a/transport_scope_policy.ts';
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
 * }); // ok([{ 'Properties.Timeout': 30 }, { 'Properties.Timeout': 30 }])
 */
export function normalizeConfigurationProjection(
  template: CfnTemplate,
  projection: ConfigurationProjectionPolicy,
): Result<JsonValue, StructuredReason> {
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
  const selected = placed.filter((resource) => constructPathMatches(resource.construct_path, selector));
  if (selected.length === 0) {
    return {
      ok: false,
      error: scopeViolation(
        'PROJECTION_SELECTS_NOTHING',
        `projection ${projection.projection_id} selects no ${projection.resource_type} under a construct path matching ` +
          `${JSON.stringify(selector)}; expected at least one resource`,
      ),
    };
  }
  const values = selected.map((resource) => projectResource(resource, projection.property_paths, resourceTypes));
  return { ok: true, value: sortCanonically(values) };
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
  propertyPaths: readonly string[],
  resourceTypes: ReadonlyMap<string, string>,
): JsonObject {
  const entries: [string, JsonValue][] = [];
  for (const path of propertyPaths) {
    const value = valueAtPath(resource.resource, path);
    if (value !== undefined) {
      entries.push([path, normalizeCfnValue(value, resourceTypes)]);
    }
  }
  return Object.fromEntries(entries);
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

function sortCanonically(values: readonly JsonObject[]): readonly JsonValue[] {
  return values
    .map((value) => ({ value, canonical: canonicalJson(value) }))
    .sort((a, b) => compareCodeUnits(a.canonical, b.canonical))
    .map((entry) => entry.value);
}
