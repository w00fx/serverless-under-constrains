// Cleanup never abandons its remaining steps because one port threw (BR-RUA-046: exceeding the
// total target is no permission to abandon cleanup). A thrown value becomes a structured reason
// on the step or surface that threw, so the failure is recorded, never swallowed.

import { boundedText } from '../record-contract/json-value.ts';
import type { StructuredReason } from '../record-contract/primitives.ts';

/** How a thrown value whose prototype, `name` or `message` cannot be read is described. */
export const UNREADABLE_THROWN = 'an unreadable value';

/**
 * A structured reason describing a thrown value: its bounded error name and message, or its
 * JavaScript type when it is not an Error. Total over every thrown value (Owner amendment A-05):
 * it runs inside the catch blocks that keep cleanup going, so an Error whose `name` or `message`
 * is a throwing getter or not a string, or a revoked proxy, must not make it throw too.
 *
 * @example
 * reasonFromThrown(new Error('socket hang up'), 'SURFACE_QUERY_THREW', 'functions');
 * // { code: 'SURFACE_QUERY_THREW', subject: 'functions', detail: 'threw Error: socket hang up; expected a result value' }
 */
export function reasonFromThrown(thrown: unknown, code: string, subject: string): StructuredReason {
  return { code, subject, detail: `threw ${describeThrown(thrown)}; expected a result value` };
}

function describeThrown(thrown: unknown): string {
  try {
    if (!(thrown instanceof Error)) {
      return `a non-Error ${typeof thrown}`;
    }
    // Typed strings, but a hostile Error can carry any value there, or a throwing getter.
    const { name, message } = thrown as { readonly name: unknown; readonly message: unknown };
    return `${textOf(name)}: ${textOf(message)}`;
  } catch {
    return UNREADABLE_THROWN;
  }
}

// `typeof` never throws, and no `toString` of the value runs, so a member is described totally.
function textOf(member: unknown): string {
  return typeof member === 'string' ? boundedText(member) : `a non-string ${typeof member}`;
}
