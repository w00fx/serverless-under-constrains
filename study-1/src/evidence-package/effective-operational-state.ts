// The effective operational state of an execution (CTR-RUA-004; design §8.15): the cleanup,
// leak-audit and lease values of the original closure, replaced only by OPERATIONAL_RECOVERY
// amendments of a verified selected chain, applied in chain order. Recovery may repair only those
// three values (BR-RUA-038). `operational_recovery_applied` is true iff at least one recovery
// changed an effective value.
//
// Nothing here is guessed: an ineligible package, a non-terminal original cleanup status, or a
// selected recovery amendment that cannot be found or read makes every value `unverified`
// (evidence/WP-13/decisions.md: the original closure is an explicit input, read by the caller
// from the summary).

import type { PackageVerification } from '../record-contract/records/group-c/package_verification.ts';
import type { OperationalClosure } from '../record-contract/records/group-c/operational_recovery_record.ts';
import type {
  CleanupStatus,
  EffectiveCleanupStatus,
  EffectiveLeakAuditStatus,
  LeakAuditStatus,
  LeaseStatus,
} from '../record-contract/records/group-c/vocabulary.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import type { AmendmentSnapshot } from './amendment-snapshots.ts';
import { fileAt } from './index-entries.ts';
import type { ByteDigest } from './package-integrity.ts';
import { AMENDMENT_PATHS } from './package-layout.ts';
import { parsePackageRecord } from './package-records.ts';

/** The closure values the original summary froze. */
export interface OriginalClosure {
  readonly cleanup_status: CleanupStatus;
  readonly leak_audit_status: LeakAuditStatus;
  readonly lease_status: LeaseStatus;
}

export interface EffectiveOperationalState {
  readonly effective_cleanup_status: EffectiveCleanupStatus;
  readonly effective_leak_audit_status: EffectiveLeakAuditStatus;
  readonly effective_lease_status: LeaseStatus;
  readonly operational_recovery_applied: boolean;
}

export interface EffectiveStateInput {
  readonly verification: PackageVerification;
  readonly original_closure: OriginalClosure;
  /** The amendment directories of the execution; the selected chain is found among them by digest. */
  readonly amendments: readonly AmendmentSnapshot[];
}

/** The services the derivation uses. */
export interface EffectiveStateDeps {
  readonly validator: RecordValidator;
  readonly digest: ByteDigest;
}

const UNVERIFIED: EffectiveOperationalState = {
  effective_cleanup_status: 'unverified',
  effective_leak_audit_status: 'unverified',
  effective_lease_status: 'unverified',
  operational_recovery_applied: false,
};

/**
 * Derives the effective cleanup, leak-audit and lease values of a verified package.
 *
 * @example
 * effectiveOperationalState({ verification, original_closure: summaryClosure, amendments }, { validator, digest: sha256Hex });
 * // { effective_cleanup_status: 'succeeded', ..., operational_recovery_applied: true } after a recovery
 */
export function effectiveOperationalState(
  input: EffectiveStateInput,
  deps: EffectiveStateDeps,
): EffectiveOperationalState {
  const { cleanup_status: cleanup } = input.original_closure;
  if (input.verification.package_eligibility === 'ineligible' || cleanup === 'not_started' || cleanup === 'running') {
    return UNVERIFIED;
  }
  let closure: OperationalClosure = { ...input.original_closure, cleanup_status: cleanup };
  let applied = false;
  const recoveries = input.verification.selected_chain.filter((link) => link.amendment_kind === 'OPERATIONAL_RECOVERY');
  for (const link of recoveries) {
    const recovered = recoveredClosure(link.amendment_index_sha256, input, deps);
    if (recovered === undefined) {
      return UNVERIFIED;
    }
    applied ||= !sameClosure(closure, recovered);
    closure = recovered;
  }
  return {
    effective_cleanup_status: closure.cleanup_status,
    effective_leak_audit_status: closure.leak_audit_status,
    effective_lease_status: closure.lease_status,
    operational_recovery_applied: applied,
  };
}

function recoveredClosure(
  indexDigest: string,
  input: EffectiveStateInput,
  deps: EffectiveStateDeps,
): OperationalClosure | undefined {
  const amendment = input.amendments.find((snapshot) => {
    const index = fileAt(snapshot.files, AMENDMENT_PATHS.amendmentIndex);
    return index !== undefined && deps.digest(index.bytes) === indexDigest;
  });
  const file = amendment === undefined ? undefined : fileAt(amendment.files, AMENDMENT_PATHS.operationalRecoveryRecord);
  if (file === undefined) {
    return undefined;
  }
  const record = parsePackageRecord(
    file.bytes,
    'operational_recovery_record',
    deps.validator,
    AMENDMENT_PATHS.operationalRecoveryRecord,
  );
  if (!record.ok || record.value.original_package_index_sha256 !== input.verification.original_package_index_sha256) {
    return undefined;
  }
  return record.value.recovered_closure;
}

function sameClosure(a: OperationalClosure, b: OperationalClosure): boolean {
  return (
    a.cleanup_status === b.cleanup_status &&
    a.leak_audit_status === b.leak_audit_status &&
    a.lease_status === b.lease_status
  );
}
