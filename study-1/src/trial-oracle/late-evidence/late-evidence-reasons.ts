// The structured reasons of a late-evidence assessment (BR-RUA-043, D-16). A late problem is a
// correlated late record, or the stream itself, that cannot be read or folded into the frozen
// evidence: late monitoring then yielded no verifiable late evidence. Problems are aggregated per
// code so the reason count is bounded by the code set, never by the stream's size (A-12).

import { aggregatedDetail } from '../../evidence-ingestion/ingestion-findings.ts';
import type { StructuredReason } from '../../record-contract/primitives.ts';

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
 * One reason per problem code, in order of first appearance: the first problem's location and
 * detail, with the count of the others.
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
    detail: aggregatedDetail(first.detail, count),
  }));
}
