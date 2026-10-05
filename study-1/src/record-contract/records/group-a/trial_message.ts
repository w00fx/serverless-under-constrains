// `trial_message` (BR-RUA-036): the canonical published message; its canonical serialization
// is the exact SQS body (`trials/<t>/inputs/published-message.json`).

import type { TrialReference, TrialScopedIdentityFields } from './trial_manifest.ts';

export type TrialMessage = TrialScopedIdentityFields &
  TrialReference & {
    readonly schema_version: 1;
    readonly record_type: 'trial_message';
    readonly payment_id: string;
    readonly refund_request_id: string;
  };
