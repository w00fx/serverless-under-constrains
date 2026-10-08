// Catalogue group B row 49 (design §6.2): the exact trial message bytes were sent to the
// variant FIFO source (BR-RUA-036).

import type { EventEnvelope } from '../../envelope.ts';
import type { Sha256Hex, Uuid4, VariantId } from '../../primitives.ts';

/** Schema: `schemas/group-b/trial_message_published.schema.json`. */
export interface TrialMessagePublished extends EventEnvelope<'trial_message_published'> {
  readonly source: 'runner';
  readonly trial_id: Uuid4;
  readonly trial_manifest_sha256: Sha256Hex;
  readonly variant_id: VariantId;
  readonly message_id: string;
  /** SQS FIFO sequence number, a base-10 digit string. */
  readonly sequence_number: string;
  /** SQS `MD5OfMessageBody`, lowercase hex. */
  readonly md5_of_message_body: string;
  readonly message_body_sha256: Sha256Hex;
  readonly message_group_id: string;
  readonly message_deduplication_id: string;
}
