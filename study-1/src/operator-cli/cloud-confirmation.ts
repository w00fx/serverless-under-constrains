// The cloud-mutation confirmation (design §11; D-14): every command that mutates the cloud takes
// `--confirm-cloud-mutation <id>`, and the value must equal the id the command is about to act on
// (the admitted execution id, or the literal `coordination` for the baseline), so a typo or a
// copied command line for another package can never start a cloud mutation. A mismatch is a
// usage error that names both values.

import { boundedJsonText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import { flagValue, usageReason } from './arg-parsing.ts';
import type { ParsedArgs } from './cli-types.ts';

/** The flag name, without its leading `--`. */
export const CONFIRM_FLAG = 'confirm-cloud-mutation';

/** The confirmation `coordination bootstrap` requires (design §11 command table). */
export const COORDINATION_CONFIRMATION = 'coordination';

/**
 * Accepts the invocation only when its confirmation equals `expected`.
 *
 * @example
 * confirmCloudMutation(args, '0b6d7a52-3c4e-4f80-9a1b-2c3d4e5f6a7b'); // ok(undefined) when the flag names that id
 */
export function confirmCloudMutation(args: ParsedArgs, expected: string): Result<void, StructuredReason> {
  const given = flagValue(args.flags, CONFIRM_FLAG);
  if (given === expected) {
    return ok(undefined);
  }
  return err(
    usageReason(
      `--${CONFIRM_FLAG} ${boundedJsonText(given)} does not confirm ${boundedJsonText(expected)}`,
      `--${CONFIRM_FLAG} ${expected}`,
    ),
  );
}
