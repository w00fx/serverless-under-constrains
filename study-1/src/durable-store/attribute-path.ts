// Attribute paths for codec errors and validation violations (pure, a mutation target).
//
// A path names where a value sits, such as `$.amounts[1]` or `action.item.state`. Member names
// come from the caller or from an untrusted record, and may be megabytes long; a path built from
// them verbatim makes every message as long as the input, and near V8's maximum string length
// building it throws RangeError instead of returning a refusal (Owner amendment A-05: messages
// are bounded in output). So a short name is appended as it is, and a longer one is quoted
// through the kernel's bounded `boundedJsonText` (WP-04 review round 2).

import { boundedJsonText, QUOTED_JSON_LIMIT } from '../record-contract/json-value.ts';

/**
 * Appends one map member to a path: `<path>.<name>` for a name of at most `QUOTED_JSON_LIMIT`
 * characters, otherwise `<path>.` plus the name's bounded JSON quotation.
 *
 * @example
 * memberPath('$', 'state'); // '$.state'
 * memberPath('$', 'x'.repeat(1_000_000)); // '$."xxx…[truncated]' (about 215 characters)
 */
export function memberPath(path: string, name: string): string {
  return name.length <= QUOTED_JSON_LIMIT ? `${path}.${name}` : `${path}.${boundedJsonText(name)}`;
}
