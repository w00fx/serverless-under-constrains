// What a caller asks the shared provider client to attempt (design §5.3 `AttemptInput`), and the
// check that runs before anything is written. The `attempt_registered` event repeats these
// fields, so an input its schema would reject must never reach the journal: such an input is a
// defect of the calling variant, not an attempt outcome, and is refused with an error. The
// fields may come from untrusted message bytes, so an offending value is quoted only through
// the kernel's bounded rendering (Owner amendment A-05.1).

import { isUuid4 } from '../record-contract/identifiers.ts';
import { boundedJsonText } from '../record-contract/json-value.ts';
import type { Uuid4 } from '../record-contract/primitives.ts';
import type { CallerId } from '../record-contract/records/group-b/vocabulary.ts';

export interface AttemptInput {
  readonly caller_id: CallerId;
  /** Business identity of the refund request, non-empty after trimming (BR-RUA-003). */
  readonly refund_request_id: string;
  /** Non-empty after trimming. */
  readonly payment_id: string;
  /** Positive safe-integer minor units (BR-RUA-033). */
  readonly amount_minor: number;
  readonly currency: 'BRL';
  /** The immutable provider version number to invoke, never `$LATEST` or an alias (BR-RUA-053). */
  readonly provider_qualifier: string;
  /** The caller events that caused this attempt; empty for a causal root. */
  readonly causation_event_ids: readonly Uuid4[];
}

// The `_defs` `nonempty_trimmed` pattern; Ajv compiles schema patterns with the `u` flag.
const NONEMPTY_TRIMMED_PATTERN = /^\S(.*\S)?$/u;
// A Lambda version number: a positive integer without leading zeros.
const PROVIDER_VERSION_PATTERN = /^[1-9][0-9]*$/u;

/**
 * Throws a RangeError naming the first field the `attempt_registered` schema would reject.
 *
 * @example
 * assertValidAttemptInput({ ...input, amount_minor: 0 }); // RangeError: amount_minor 0; expected a safe integer >= 1
 */
export function assertValidAttemptInput(input: AttemptInput): void {
  const violation = firstViolation(input);
  if (violation !== undefined) {
    throw new RangeError(`invalid attempt input: ${violation}`);
  }
}

function firstViolation(input: AttemptInput): string | undefined {
  for (const field of ['refund_request_id', 'payment_id'] as const) {
    if (!NONEMPTY_TRIMMED_PATTERN.test(input[field])) {
      return `${field} ${boundedJsonText(input[field])}; expected a string without leading or trailing whitespace and at least one character`;
    }
  }
  if (!Number.isSafeInteger(input.amount_minor) || input.amount_minor < 1) {
    return `amount_minor ${String(input.amount_minor)}; expected a safe integer >= 1`;
  }
  if (!PROVIDER_VERSION_PATTERN.test(input.provider_qualifier)) {
    return `provider_qualifier ${boundedJsonText(input.provider_qualifier)}; expected a Lambda version number such as "7"`;
  }
  // Typed as UUIDs, but a variant may forward ids parsed from untrusted message bytes.
  const causes: readonly string[] = input.causation_event_ids;
  const badCause = causes.find((id) => !isUuid4(id));
  if (badCause !== undefined) {
    return `causation event id ${boundedJsonText(badCause)}; expected a lowercase UUIDv4`;
  }
  return undefined;
}
