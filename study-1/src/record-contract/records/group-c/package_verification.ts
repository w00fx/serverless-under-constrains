// Catalogue group C row 80 (design §6.2, §6.3, §8.16): the package verifier's output, written
// under `evidence/verifications/`, never inside a package (BR-RUA-044, AC-RUA-022, D-12).
// Eligibility proves faithful structure and integrity, never scientific or operational success.

import type { Sha256Hex, StructuredReason, Uuid4, UtcMillis } from '../../primitives.ts';
import type { ExecutionIdentityFields } from '../../envelope.ts';
import type { AmendmentKind, PackageIneligibilityCode } from './vocabulary.ts';

/** One amendment the verifier found, by the digest of its amendment index. */
export interface AmendmentLink {
  readonly sequence: number;
  readonly amendment_id: Uuid4;
  readonly amendment_kind: AmendmentKind;
  readonly amendment_index_sha256: Sha256Hex;
}

/** A structured reason whose code is a package-ineligibility code. */
export type PackageIneligibilityReason = StructuredReason & { readonly code: PackageIneligibilityCode };

/** `eligible` iff there are no reasons (design §8.16 step 7). */
export type PackageEligibilityOutcome =
  | { readonly package_eligibility: 'eligible'; readonly package_ineligibility_reasons: readonly [] }
  | {
      readonly package_eligibility: 'ineligible';
      readonly package_ineligibility_reasons: readonly [PackageIneligibilityReason, ...PackageIneligibilityReason[]];
    };

/** No selected head means no selected chain. */
export type SelectedChain =
  | { readonly selected_amendment_head_sha256: null; readonly selected_chain: readonly [] }
  | {
      readonly selected_amendment_head_sha256: Sha256Hex;
      /** From sequence 1 to the selected head. */
      readonly selected_chain: readonly AmendmentLink[];
    };

interface PackageVerificationFields {
  readonly schema_version: 1;
  readonly record_type: 'package_verification';
  readonly original_package_index_sha256: Sha256Hex;
  /** Every amendment found for the package, selected or not. */
  readonly known_descendants: readonly AmendmentLink[];
  readonly evaluated_at: UtcMillis;
}

/** Schema: `schemas/group-c/package_verification.schema.json`. */
export type PackageVerification = PackageVerificationFields &
  ExecutionIdentityFields &
  PackageEligibilityOutcome &
  SelectedChain;
