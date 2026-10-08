// The structured reasons of a late-evidence assessment (BR-RUA-043, D-16). A late problem is a
// correlated late record, or the stream itself, that cannot be read or folded into the frozen
// evidence: late monitoring then yielded no verifiable late evidence. Problems are aggregated per
// code so the reason count is bounded by the code set, never by the stream's size (A-12).

import { boundedJsonText } from '../../record-contract/json-value.ts';
import type { StructuredReason } from '../../record-contract/primitives.ts';
import type { SchemaViolation } from '../../record-contract/schema-registry.ts';

/** Every late assessment reason names the rule it applies. */
export const LATE_EVIDENCE_SUBJECT = 'BR-RUA-043';

/** Why late evidence cannot be assessed; each one makes the late evidence unverified. */
export const LATE_PROBLEM_CODES = [
  'LATE_STREAM_MISSING',
  'LATE_STREAM_TRUNCATED',
  'LATE_RECORD_UNREADABLE',
  'LATE_RECORD_SCHEMA_INVALID',
  'LATE_RECORD_FOREIGN',
  'LATE_SEQUENCE_BROKEN',
  'LATE_RECORD_TYPE_MISMATCH',
  'LATE_RECORD_UNROUTABLE',
  'LATE_TRIAL_MANIFEST_MISMATCH',
  'LATE_DOCUMENT_UNFOLDABLE',
] as const;
export type LateProblemCode = (typeof LATE_PROBLEM_CODES)[number];

/** One problem, located at the artifact it was found in. */
export interface LateProblem {
  readonly code: LateProblemCode;
  readonly artifact_path: string;
  readonly detail: string;
}

/**
 * The first violation of a failed schema validation as bounded JSON text (`"<path> <detail>"`), so
 * every late-evidence detail quotes an untrusted record the same way (A-05: kernel helper, bounded).
 *
 * @example
 * describeFirstViolation(validation.violations); // '"/pages must be array"'
 */
export function describeFirstViolation(violations: readonly SchemaViolation[]): string {
  const [first] = violations;
  return boundedJsonText(first === undefined ? '' : `${first.instance_path} ${first.detail}`);
}

/**
 * One reason per problem code, in order of first appearance: the first problem's location and
 * whole detail, with the count of the others. Every problem detail is already bounded (it quotes
 * untrusted values only through the kernel's bounded helpers), so it is kept whole: cutting it
 * would drop the expected shape that ends it.
 *
 * @example
 * lateProblemReasons([gapAtLine3, gapAtLine7])[0]?.detail; // '... (and 1 more)'
 */
export function lateProblemReasons(problems: readonly LateProblem[]): readonly StructuredReason[] {
  const groups = new Map<LateProblemCode, { readonly first: LateProblem; count: number }>();
  for (const problem of problems) {
    const group = groups.get(problem.code);
    if (group === undefined) {
      groups.set(problem.code, { first: problem, count: 1 });
    } else {
      group.count += 1;
    }
  }
  return [...groups.values()].map(({ first, count }) => ({
    code: first.code,
    subject: LATE_EVIDENCE_SUBJECT,
    artifact_path: first.artifact_path,
    detail: count > 1 ? `${first.detail} (and ${String(count - 1)} more)` : first.detail,
  }));
}
