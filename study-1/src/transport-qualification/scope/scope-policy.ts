// The committed transport-scope policy (BR-RUA-028): critical entry points, conservative
// source roots, configuration projections, runtime properties and relevant dependencies.
//
// Its digest is a file digest: lowercase SHA-256 over the exact committed bytes (BR-RUA-033
// "File digests are lowercase SHA-256 over the exact stored bytes"; BR-RUA-028 "the policy
// digest"), so an auditor can reproduce it from the policy file at the admitted commit. A
// reformat of the policy is therefore scoped drift too, which errs on the conservative side.
//
// Projection selector convention: the part of `projection_id` before an optional `__` names
// a construct. It selects every template resource of `resource_type` whose stack-relative
// CDK construct path contains a contiguous run of segments whose snake_case forms, joined by
// `_`, equal the selector. `experiment_core__functions` therefore selects every
// `AWS::Lambda::Function` under the `ExperimentCore` construct, and the stack name (which
// carries the execution id) never takes part in the match.

import { sha256Hex } from '../../record-contract/digests.ts';
import { boundedJsonText } from '../../record-contract/json-value.ts';
import { parseJsonDocument } from '../../record-contract/parsing.ts';
import type { Result, Sha256Hex, StructuredReason } from '../../record-contract/primitives.ts';
import type { TransportScopePolicy } from '../../record-contract/records/group-a/transport_scope_policy.ts';
import type { RecordValidator } from '../../record-contract/schema-registry.ts';
import { scopeViolation } from './scope-reasons.ts';

/** Package-relative path of the committed policy (design §6.2 row 12). */
export const TRANSPORT_SCOPE_POLICY_PATH = 'src/transport-qualification/transport-scope.policy.json';

export interface LoadedScopePolicy {
  readonly policy: TransportScopePolicy;
  /** Lowercase SHA-256 over the exact committed bytes of the policy file. */
  readonly policy_sha256: Sha256Hex;
}

/**
 * Parses and validates the committed policy bytes and computes the policy digest.
 *
 * @example
 * const loaded = parseTransportScopePolicy(await sources.read(TRANSPORT_SCOPE_POLICY_PATH), validator);
 * if (loaded.ok) use(loaded.value.policy_sha256);
 */
export function parseTransportScopePolicy(
  bytes: Uint8Array,
  validator: RecordValidator,
): Result<LoadedScopePolicy, readonly StructuredReason[]> {
  const parsed = parseJsonDocument(bytes);
  if (!parsed.ok) {
    const failure =
      parsed.error.kind === 'invalid_utf8'
        ? `invalid UTF-8 at byte ${String(parsed.error.byte_offset)}`
        : parsed.error.detail;
    return {
      ok: false,
      error: [
        scopeViolation(
          'SCOPE_POLICY_UNREADABLE',
          `${TRANSPORT_SCOPE_POLICY_PATH}: ${failure}; expected one JSON document`,
        ),
      ],
    };
  }
  const validation = validator.validateAs('transport_scope_policy', parsed.value);
  if (!validation.valid) {
    return {
      ok: false,
      error: validation.violations.map((violation) =>
        scopeViolation(
          'SCOPE_POLICY_INVALID',
          `${TRANSPORT_SCOPE_POLICY_PATH}${violation.instance_path} fails ${violation.keyword}: ${violation.detail}`,
        ),
      ),
    };
  }
  const policy = validation.record as TransportScopePolicy;
  const duplicates = duplicateProjectionIds(policy);
  if (duplicates.length > 0) {
    return {
      ok: false,
      error: duplicates.map((id) =>
        scopeViolation(
          'SCOPE_POLICY_DUPLICATE_PROJECTION',
          `projection_id ${boundedJsonText(id)} is declared more than once; expected unique projection ids`,
        ),
      ),
    };
  }
  return { ok: true, value: { policy, policy_sha256: sha256Hex(bytes) } };
}

/**
 * The construct selector of a projection: its id up to an optional `__` label separator.
 *
 * @example
 * projectionSelector('experiment_core__functions'); // 'experiment_core'
 * projectionSelector('provider'); // 'provider'
 */
export function projectionSelector(projectionId: string): string {
  const separator = projectionId.indexOf('__');
  return separator === -1 ? projectionId : projectionId.slice(0, separator);
}

function duplicateProjectionIds(policy: TransportScopePolicy): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const projection of policy.configuration_projections) {
    if (seen.has(projection.projection_id)) {
      duplicates.add(projection.projection_id);
    }
    seen.add(projection.projection_id);
  }
  return [...duplicates];
}
