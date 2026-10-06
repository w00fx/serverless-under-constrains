// Cleanup never abandons its remaining steps because one port threw (BR-RUA-046: exceeding the
// total target is no permission to abandon cleanup). A thrown value becomes a structured reason
// on the step or surface that threw, so the failure is recorded, never swallowed.

import { boundedText } from '../record-contract/json-value.ts';
import type { StructuredReason } from '../record-contract/primitives.ts';

/**
 * A structured reason describing a thrown value: its error name and bounded message, or its
 * JavaScript type when it is not an Error.
 *
 * @example
 * reasonFromThrown(new Error('socket hang up'), 'SURFACE_QUERY_THREW', 'functions');
 * // { code: 'SURFACE_QUERY_THREW', subject: 'functions', detail: 'threw Error: socket hang up; expected a result value' }
 */
export function reasonFromThrown(thrown: unknown, code: string, subject: string): StructuredReason {
  const described =
    thrown instanceof Error ? `${thrown.name}: ${boundedText(thrown.message)}` : `a non-Error ${typeof thrown}`;
  return { code, subject, detail: `threw ${described}; expected a result value` };
}
