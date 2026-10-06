// The constructors of admission reasons: an UPPER_SNAKE code, the rule the check enforces as
// subject, and a detail that names the offending value and the expected shape. A read port's
// failure keeps the port's own code and detail inside the admission reason, bounded, so a hostile
// or huge error text never floods the journal (A-05).

import { boundedText } from '../record-contract/json-value.ts';
import type { StructuredReason } from '../record-contract/primitives.ts';
import type { PortFailure } from './admission-ports.ts';

/**
 * A structured admission reason.
 *
 * @example
 * admissionReason('AMOUNTS_UNEQUAL', 'BR-RUA-017', 'captured 10000 and approved 9000; expected equal amounts');
 */
export function admissionReason(code: string, subject: string, detail: string): StructuredReason {
  return { code, subject, detail };
}

/**
 * The reason of a read that could not answer.
 *
 * @example
 * portFailureReason('CALLER_IDENTITY_UNREADABLE', 'BR-RUA-041', 'sts:GetCallerIdentity', { code: 'ExpiredToken', detail: '…' });
 */
export function portFailureReason(code: string, subject: string, read: string, failure: PortFailure): StructuredReason {
  return admissionReason(
    code,
    subject,
    `${read} failed with ${boundedText(failure.code)}: ${boundedText(failure.detail)}; expected a successful read`,
  );
}
