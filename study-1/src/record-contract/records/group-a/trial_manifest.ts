// `trial_manifest` (BR-RUA-040, BR-RUA-019): frozen before publication; it references the exact
// parent execution-manifest and resource-manifest digests and pins the trial's input files.

import type { Scenario, Sha256Hex, UtcMillis, Uuid4, VariantId } from '../../primitives.ts';

/**
 * The execution identity of anything that belongs to a trial: a run or a variant validation.
 * A transport probe has no trial (D-06), so `transport_probe_id` never appears here.
 */
export type TrialScopedIdentityFields =
  | { readonly run_id: Uuid4; readonly variant_validation_id?: never }
  | { readonly variant_validation_id: Uuid4; readonly run_id?: never };

/** The trial identity pair that travels together on every trial-scoped record. */
export interface TrialReference {
  readonly trial_id: Uuid4;
  readonly trial_manifest_sha256: Sha256Hex;
}

export type TrialManifest = TrialScopedIdentityFields & {
  readonly schema_version: 1;
  readonly record_type: 'trial_manifest';
  readonly execution_manifest_sha256: Sha256Hex;
  readonly resource_manifest_sha256: Sha256Hex;
  readonly trial_id: Uuid4;
  /** Position in the declared order: 1-4 for a run, 1-2 for a variant validation. */
  readonly sequence: number;
  readonly variant_id: VariantId;
  readonly scenario: Scenario;
  /** Digest of `trials/<t>/inputs/payment.json`. */
  readonly payment_sha256: Sha256Hex;
  /** Digest of `trials/<t>/inputs/approved-decision.json`. */
  readonly approved_decision_sha256: Sha256Hex;
  readonly frozen_at: UtcMillis;
};
