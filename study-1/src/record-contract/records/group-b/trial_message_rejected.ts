// Catalogue group B row 20 (design §6.2): the consumer rejected a delivered trial message
// and called no provider (BR-RUA-036, AC-RUA-019, D-28).

import type { EventEnvelope } from '../../envelope.ts';
import type { Sha256Hex } from '../../primitives.ts';
import type { TrialMessageRejectionReason } from './vocabulary.ts';

/** Schema: `schemas/group-b/trial_message_rejected.schema.json`. */
export interface TrialMessageRejected extends EventEnvelope<'trial_message_rejected'> {
  readonly source: 'conventional_caller' | 'durable_caller';
  readonly message_id: string;
  readonly message_body_sha256: Sha256Hex;
  readonly reason: TrialMessageRejectionReason;
  readonly detail: string;
  /** The value that failed the check, when the message carried one. */
  readonly offending_value?: string;
  /** The value the active trial registration expected. */
  readonly expected_value?: string;
  readonly refund_request_id?: string;
  readonly payment_id?: string;
}
