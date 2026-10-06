// The structured reasons the study comparison writes (design §8.14) and the two list rules every
// record of this feature follows: reasons are listed once each, and evidence references are listed
// once each in the canonical BR-RUA-035 order. Codes are UPPER_SNAKE and closed for this producer.

import { canonicalJson } from '../record-contract/canonical-json.ts';
import { compareEvidenceRefs, sortEvidenceRefs } from '../record-contract/evidence-refs.ts';
import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import type { StructuredReason } from '../record-contract/primitives.ts';

/** Every reason code this feature writes, closed (BR-RUA-033 "closed per producer"). */
export const STUDY_COMPARISON_REASON_CODES = [
  // Equality (BR-RUA-007): the design §8.14 report form `UNDECLARED_DIFFERENCE: <projection>.<field>`.
  'UNDECLARED_DIFFERENCE',
  'EQUALITY_INDETERMINATE',
  // Missing frozen evidence (BR-RUA-035 absence code, so an indeterminate result may cite none).
  'ARTIFACT_MISSING',
  'ARTIFACT_UNREADABLE',
  // Comparison eligibility (BR-RUA-031, BR-RUA-052).
  'ORACLE_RESULT_MISSING',
  'TRIAL_NOT_VALID',
  'CONTROL_INTEGRITY_NOT_VERIFIED',
  'TREATMENT_FIDELITY_NOT_VERIFIED',
  'EVIDENCE_INTEGRITY_NOT_VERIFIED',
  'CROSS_TRIAL_IDENTITY_REUSE',
  'LATE_EVIDENCE_NOT_ACCEPTABLE',
  'CONTRADICTORY_AMENDMENT',
  'ISOLATION_COMPROMISING_LEAK',
  // Run summary (CTR-RUA-002, D-29).
  'TRIAL_NOT_STARTED',
  'TRIAL_NOT_FROZEN',
  // Study completion (BR-RUA-054).
  'COMPARISON_NOT_ELIGIBLE',
  'PACKAGE_NOT_ELIGIBLE',
  'CLOSURE_NOT_CLEAN',
  'RUN_NOT_COMPLETED',
  'EQUALITY_NOT_EVALUATED',
  'KNOWN_SAFETY_BREACH',
  'OWNED_RESOURCE_REMAINS',
  'SOURCE_NOT_CLEAN',
  'QUALIFICATION_MISMATCH',
] as const;
export type StudyComparisonReasonCode = (typeof STUDY_COMPARISON_REASON_CODES)[number];

/**
 * Builds one reason of this feature; `detail` names the offending value and the expected shape.
 *
 * @example
 * comparisonReason('UNDECLARED_DIFFERENCE', 'treatment_parameters.treatment_poll_interval_ms', '250 versus 500; expected equal values');
 */
export function comparisonReason(
  code: StudyComparisonReasonCode,
  subject: string,
  detail: string,
  artifactPath?: string,
): StructuredReason {
  return artifactPath === undefined
    ? { code, subject, detail }
    : { code, subject, artifact_path: artifactPath, detail };
}

/**
 * The reasons in their first-seen order with structural duplicates removed: one missing oracle
 * result fails several eligibility checks, and the union lists it once.
 *
 * @example
 * uniqueReasons([missing, missing, invalid]); // [missing, invalid]
 */
export function uniqueReasons(reasons: readonly StructuredReason[]): readonly StructuredReason[] {
  const seen = new Set<string>();
  return reasons.filter((reason) => {
    const key = canonicalJson({
      code: reason.code,
      subject: reason.subject,
      artifact_path: reason.artifact_path ?? null,
      event_id: reason.event_id ?? null,
      detail: reason.detail,
    });
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * The references in canonical order with structural duplicates removed (BR-RUA-035: sorted and
 * duplicate-free). The kernel sort keeps duplicates, so equal neighbours are dropped here.
 *
 * @example
 * uniqueSortedRefs([manifestRef, paymentRef, manifestRef]); // [manifestRef, paymentRef] in canonical order
 */
export function uniqueSortedRefs(refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  const kept: EvidenceRef[] = [];
  for (const ref of sortEvidenceRefs(refs)) {
    const last = kept.at(-1);
    if (last === undefined || compareEvidenceRefs(last, ref) !== 0) {
      kept.push(ref);
    }
  }
  return kept;
}
