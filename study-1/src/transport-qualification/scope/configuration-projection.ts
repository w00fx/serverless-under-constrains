// Configuration projections of the transport scope (BR-RUA-028): for one policy projection,
// the normalized values of its property paths on every selected template resource.
//
// Each selected resource contributes one object mapping every declared property path to its
// normalized value, or to `null` when the resource does not set it: an absent property is
// configuration too (for example "no reserved concurrency"), so setting it later is drift.
// The objects are sorted by their canonical form, because the logical ids and some construct
// paths below the selector embed execution-specific hashes and cannot serve as keys.

import { canonicalJson } from '../../record-contract/canonical-json.ts';
import type { JsonObject, JsonValue, Result, StructuredReason } from '../../record-contract/primitives.ts';
import type { ConfigurationProjectionPolicy } from '../../record-contract/records/group-a/transport_scope_policy.ts';
import { compareCodeUnits } from './bundle-inputs.ts';
import type { CfnTemplate, TemplateResource } from './cfn-template.ts';
import { listTemplateResources, valueAtPath } from './cfn-template.ts';
import { normalizeCfnValue } from './cfn-value-normalization.ts';
import { projectionSelector } from './scope-policy.ts';
import { scopeViolation } from './scope-reasons.ts';

/**
 * Projects and normalizes one policy projection over a template. Fails when the template is
 * malformed or when the projection selects no resource (a renamed construct must never drop
 * configuration from the scope silently).
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
  const selector = projectionSelector(projection.projection_id);
  const selected = resources.value.filter(
    (resource) => resource.type === projection.resource_type && constructPathMatches(resource.construct_path, selector),
  );
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
  const projected: Record<string, JsonValue> = {};
  for (const path of propertyPaths) {
    const value = valueAtPath(resource.resource, path);
    projected[path] = value === undefined ? null : normalizeCfnValue(value, resourceTypes);
  }
  return projected;
}

function sortCanonically(values: readonly JsonObject[]): readonly JsonValue[] {
  return values
    .map((value) => ({ value, canonical: canonicalJson(value) }))
    .sort((a, b) => compareCodeUnits(a.canonical, b.canonical))
    .map((entry) => entry.value);
}
