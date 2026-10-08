// Catalogue group C row 82 (design §6.2, §6.3, §8.15): exactly the CTR-RUA-004 fields plus
// `validation_validity`. Operational recovery may repair only cleanup, audit and lease closure.

import type { EvidenceRef } from '../../evidence-refs.ts';
import type { Sha256Hex, StructuredReason, Uuid4, UtcMillis } from '../../primitives.ts';
import type { CrossPackageRef } from './shared-shapes.ts';
import type {
  EffectiveCleanupStatus,
  EffectiveLeakAuditStatus,
  Eligibility,
  ImplementationValidationStatus,
  LeaseStatus,
  TrialValidity,
} from './vocabulary.ts';

/**
 * A conclusive effective status (`verified` or `failed`) needs an eligible package, a valid
 * validation and a clean effective closure; anything else is `indeterminate` (CTR-RUA-004).
 */
export type EffectiveValidationOutcome =
  | {
      readonly effective_implementation_validation_status: 'verified' | 'failed';
      readonly package_eligibility: 'eligible';
      readonly validation_validity: 'valid';
      readonly effective_cleanup_status: 'succeeded';
      readonly effective_leak_audit_status: 'clean';
      readonly effective_lease_status: 'released';
    }
  | {
      readonly effective_implementation_validation_status: 'indeterminate';
      readonly package_eligibility: Eligibility;
      readonly validation_validity: TrialValidity;
      readonly effective_cleanup_status: EffectiveCleanupStatus;
      readonly effective_leak_audit_status: EffectiveLeakAuditStatus;
      readonly effective_lease_status: LeaseStatus;
    };

interface VariantValidationVerificationFields {
  readonly schema_version: 1;
  readonly record_type: 'variant_validation_verification';
  readonly variant_validation_id: Uuid4;
  /** The verifier output lives outside the package, so the reference names its index digest. */
  readonly validation_summary_ref: CrossPackageRef;
  readonly original_package_index_sha256: Sha256Hex;
  readonly selected_amendment_head_sha256: Sha256Hex | null;
  readonly declared_implementation_validation_status: ImplementationValidationStatus;
  readonly operational_recovery_applied: boolean;
  readonly effective_status_reasons: readonly StructuredReason[];
  readonly evidence_refs: readonly EvidenceRef[];
  readonly checked_at: UtcMillis;
}

/** Schema: `schemas/group-c/variant_validation_verification.schema.json`. */
export type VariantValidationVerification = VariantValidationVerificationFields & EffectiveValidationOutcome;
