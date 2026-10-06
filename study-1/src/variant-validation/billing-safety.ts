// What a selected BILLING amendment adds to the safety standing of a variant validation
// (BR-RUA-046, BR-RUA-047, OR-RUA-005; design §8.15, §8.17). A billing import is a safety finding,
// not an operational recovery: it never repairs closure. The last BILLING amendment of the
// verified selected chain decides:
// - `breached`: the billed cost exceeded the ceiling, a known safety breach;
// - `within_limit`: a billed cost that was pending is now verified, so a pending bill is resolved;
// - `unverified`: the bill is still pending, so the original standing stands;
// - a payload that cannot be found or read, or that belongs to another original package, cannot
//   show the bill was within its ceiling: unverified safety.

import type { Sha256Hex } from '../record-contract/primitives.ts';
import type { PackageVerification } from '../record-contract/records/group-c/package_verification.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import type { AmendmentSnapshot } from '../evidence-package/amendment-snapshots.ts';
import type { ByteDigest } from '../evidence-package/package-integrity.ts';
import { AMENDMENT_PATHS } from '../evidence-package/package-layout.ts';
import { selectedAmendment } from './selected-amendment.ts';
import { safetyReasons } from './safety-standing.ts';
import type { SafetyStanding } from './safety-standing.ts';
import { readValidationRecord } from './validation-records.ts';
import { validationReason } from './validation-reasons.ts';

/** The services billing reading uses. */
export interface BillingSafetyDeps {
  readonly validator: RecordValidator;
  readonly digest: ByteDigest;
}

const SUBJECT = 'safety_status';

/**
 * The safety standing after the last selected BILLING amendment, if any.
 *
 * @example
 * billedSafetyStanding({ standing: 'billing_pending' }, verification, amendments, deps);
 * // { standing: 'within_limits' } once a selected billing import is within its limit
 */
export function billedSafetyStanding(
  standing: SafetyStanding,
  verification: PackageVerification,
  amendments: readonly AmendmentSnapshot[],
  deps: BillingSafetyDeps,
): SafetyStanding {
  const link = verification.selected_chain.findLast((candidate) => candidate.amendment_kind === 'BILLING');
  if (link === undefined) {
    return standing;
  }
  const billing = readBillingImport(link.amendment_index_sha256, verification, amendments, deps);
  if (!billing.ok) {
    const reason = validationReason('SAFETY_UNVERIFIED', SUBJECT, billing.problem, AMENDMENT_PATHS.billingImport);
    return { standing: 'unverified', reasons: [...safetyReasons(standing), reason] };
  }
  switch (billing.check) {
    case 'breached': {
      const detail = `the selected billing import records billed_cost_check breached (amendment ${link.amendment_index_sha256}); expected within_limit`;
      const reason = validationReason('SAFETY_BREACHED', SUBJECT, detail, AMENDMENT_PATHS.billingImport);
      return { standing: 'breached', reasons: [...safetyReasons(standing), reason] };
    }
    case 'within_limit':
      return standing.standing === 'billing_pending' ? { standing: 'within_limits' } : standing;
    case 'unverified':
      return standing;
  }
}

type BillingRead =
  | { readonly ok: true; readonly check: 'within_limit' | 'breached' | 'unverified' }
  | { readonly ok: false; readonly problem: string };

function readBillingImport(
  indexDigest: Sha256Hex,
  verification: PackageVerification,
  amendments: readonly AmendmentSnapshot[],
  deps: BillingSafetyDeps,
): BillingRead {
  const amendment = selectedAmendment(indexDigest, amendments, deps.digest);
  if (amendment === undefined) {
    return {
      ok: false,
      problem: `the selected BILLING amendment ${indexDigest} is not among the amendments; expected its directory`,
    };
  }
  const read = readValidationRecord(amendment.files, AMENDMENT_PATHS.billingImport, 'billing_import', deps.validator);
  if (!read.ok) {
    return { ok: false, problem: read.error };
  }
  const billing = read.value.record;
  if (billing.original_package_index_sha256 !== verification.original_package_index_sha256) {
    return {
      ok: false,
      problem: `the billing import amends package ${billing.original_package_index_sha256}; expected ${verification.original_package_index_sha256}`,
    };
  }
  return { ok: true, check: billing.billed_cost_check };
}
