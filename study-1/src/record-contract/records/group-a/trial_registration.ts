// `trial_registration` (BR-RUA-036, D-21): the trial-registry item naming one variant's active
// trial. Variants read it to validate delivered messages; it is neither control state nor ledger.

import type { Sha256Hex, UtcMillis, VariantId } from '../../primitives.ts';
import type { TrialReference, TrialScopedIdentityFields } from './trial_manifest.ts';

export type TrialRegistration = TrialScopedIdentityFields &
  TrialReference & {
    readonly schema_version: 1;
    readonly record_type: 'trial_registration';
    readonly variant_id: VariantId;
    readonly execution_manifest_sha256: Sha256Hex;
    /** Increases with every conditional runner write of the registry item. */
    readonly registry_version: number;
    readonly registered_at: UtcMillis;
  };
