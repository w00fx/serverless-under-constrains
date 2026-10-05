// Which parts of a group-C record the generic AC-RUA-046 checks may mutate. Two kinds of member
// are deliberately open, so a schema is right to accept another JSON kind there:
// - free-form values: the expected/observed values of rules and conditions, the projected
//   values of comparisons and reassessments, the embedded late record and the CLI result
//   record (each validated against its own contract elsewhere);
// - meaningful nulls (BR-RUA-033): the members whose null is a stated value.

import type { JsonPath } from '../../group-b/support/json-paths.ts';

// Per top-level member, the nested member names that are free-form ('*': the whole member).
const FREE_FORM_MEMBERS: Readonly<Record<string, readonly string[] | '*'>> = {
  rule_results: ['expected', 'observed'],
  treatment_condition_results: ['expected', 'observed'],
  condition_results: ['expected', 'observed'],
  equality_projections: ['value'],
  reassessments: ['frozen', 'reassessed'],
  late_record: '*',
  result_record: '*',
};

/** The members whose null is meaningful (BR-RUA-033 "null only with meaning"). */
export const NULLABLE_MEMBERS: readonly string[] = [
  'processing_terminal_reason',
  'correct_completion',
  'selected_amendment_head_sha256',
  'parent_amendment_index_sha256',
];

/**
 * Free-form members that also admit null: a reassessed verdict projection compares values such
 * as `correct_completion` and `processing_terminal_reason`, whose null is itself meaningful.
 */
export const NULLABLE_FREE_FORM_MEMBERS: readonly string[] = ['frozen', 'reassessed'];

/**
 * True when `path` is, or lies inside, a free-form value.
 *
 * @example
 * isFreeForm(['rule_results', 0, 'observed', 'count']); // true
 */
export function isFreeForm(path: JsonPath): boolean {
  const governed = FREE_FORM_MEMBERS[String(path[0])];
  if (governed === undefined) {
    return false;
  }
  return governed === '*' || path.slice(1).some((segment) => governed.includes(String(segment)));
}

/**
 * True when the member at the end of `path` admits a meaningful null.
 *
 * @example
 * isNullable(['trial_results', 0, 'correct_completion']); // true
 */
export function isNullable(path: JsonPath): boolean {
  return NULLABLE_MEMBERS.includes(String(path.at(-1)));
}

// The prose of a structured reason: free text whose words may coincide with vocabulary values.
const PROSE_MEMBERS: readonly string[] = ['subject', 'detail'];

/**
 * True when the member at the end of `path` is reason prose rather than a closed value.
 *
 * @example
 * isProse(['reasons', 0, 'subject']); // true
 */
export function isProse(path: JsonPath): boolean {
  return PROSE_MEMBERS.includes(String(path.at(-1)));
}
