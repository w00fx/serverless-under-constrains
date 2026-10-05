// `provider_refund_call` (BR-RUA-018, BR-RUA-028): the payload the shared provider client sends
// to the controlled provider. Trial-scoped calls come from a variant caller and carry the trial
// identity; a transport-probe call comes from the probe caller and has no trial (D-06).

import type { Sha256Hex, Uuid4 } from '../../primitives.ts';
import type { TrialReference, TrialScopedIdentityFields } from './trial_manifest.ts';

/** Every caller the provider can register for in-handler authorization (D-09). */
export const PROVIDER_CALLER_IDS = ['conventional', 'durable', 'probe'] as const;
export type ProviderCallerId = (typeof PROVIDER_CALLER_IDS)[number];

/** Who calls, inside which execution: a variant within a trial, or the probe caller. */
export type ProviderCallScope =
  | (TrialScopedIdentityFields &
      TrialReference & { readonly caller_id: 'conventional' | 'durable'; readonly transport_probe_id?: never })
  | {
      readonly caller_id: 'probe';
      readonly transport_probe_id: Uuid4;
      readonly run_id?: never;
      readonly variant_validation_id?: never;
      readonly trial_id?: never;
      readonly trial_manifest_sha256?: never;
    };

export type ProviderRefundCall = ProviderCallScope & {
  readonly schema_version: 1;
  readonly record_type: 'provider_refund_call';
  readonly execution_manifest_sha256: Sha256Hex;
  readonly attempt_id: Uuid4;
  readonly provider_request_id: Uuid4;
  readonly refund_request_id: string;
  readonly payment_id: string;
  /** Positive safe integer; the provider never compares it with the approved decision. */
  readonly amount_minor: number;
  /** ISO 4217-shaped; the provider rejects a mismatch with the payment currency. */
  readonly currency: string;
};
