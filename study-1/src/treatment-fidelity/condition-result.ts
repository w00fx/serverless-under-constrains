// How one condition's judgement becomes a `ConditionResult` (BR-RUA-027, BR-RUA-035, design §8.10).
// A condition states its draft: the result its rule reaches, the structured expected and observed
// values, the evidence it cites and, when indeterminate, why. Finishing the draft applies the rules
// every condition shares:
// - references are canonical and duplicate-free (BR-RUA-035);
// - a conclusive draft that cites evidence an ingestion finding touches (a gapped instance, a
//   conflict, unreadable bytes, an unresolved predecessor) is downgraded to `indeterminate`, and
//   `affected_by` names the finding codes (BR-RUA-034; the "unaffected" requirement of BR-RUA-027);
// - only an indeterminate result carries reasons.

import { eventRef } from '../evidence-ingestion/gate-assessment.ts';
import { findingReason } from '../evidence-ingestion/ingestion-findings.ts';
import type { IndexedEvent, IngestionFinding } from '../evidence-ingestion/ingestion-model.ts';
import { compareEvidenceRefs, sortEvidenceRefs } from '../record-contract/evidence-refs.ts';
import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import type { JsonValue, StructuredReason } from '../record-contract/primitives.ts';
import type { ConditionResult } from '../record-contract/records/group-c/shared-shapes.ts';
import type {
  ConditionId,
  IngestionFindingCode,
  PreservationVerdict,
} from '../record-contract/records/group-c/vocabulary.ts';
import { affectingFindings } from './subject-artifacts.ts';

/** What a condition's rule concluded, before the shared rules apply. */
export interface ConditionDraft {
  readonly result: PreservationVerdict;
  readonly expected: JsonValue;
  readonly observed: JsonValue;
  readonly refs: readonly (EvidenceRef | undefined)[];
  /** Why an indeterminate draft is indeterminate; ignored for a conclusive draft. */
  readonly reasons: readonly StructuredReason[];
}

/**
 * Finishes a draft into the condition's result.
 *
 * @example
 * finishCondition('BR-RUA-010', { result: 'pass', expected, observed, refs: [eventRef(k)], reasons: [] }, findings);
 */
export function finishCondition(
  conditionId: ConditionId,
  draft: ConditionDraft,
  findings: readonly IngestionFinding[],
): ConditionResult {
  const refs = canonicalRefs(draft.refs.filter((ref): ref is EvidenceRef => ref !== undefined));
  const affecting = affectingFindings(findings, refs);
  const result = affecting.length > 0 ? 'indeterminate' : draft.result;
  const reasons = result === 'indeterminate' ? uniqueReasons([...draft.reasons, ...affecting.map(findingReason)]) : [];
  return {
    condition_id: conditionId,
    result,
    expected: draft.expected,
    observed: draft.observed,
    evidence_refs: refs,
    indeterminate_reasons: reasons,
    affected_by: [...new Set<IngestionFindingCode>(affecting.map((finding) => finding.code))].toSorted(),
  };
}

/**
 * References in canonical order without duplicates (BR-RUA-035).
 *
 * @example
 * canonicalRefs([b, a, b]); // [a, b]
 */
export function canonicalRefs(refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  const unique: EvidenceRef[] = [];
  for (const ref of sortEvidenceRefs(refs)) {
    const previous = unique.at(-1);
    if (previous === undefined || compareEvidenceRefs(previous, ref) !== 0) {
      unique.push(ref);
    }
  }
  return unique;
}

/**
 * The reference to an event that may be absent.
 *
 * @example
 * refOf(view.caller_timeout); // undefined when Θ is absent
 */
export function refOf(event: IndexedEvent | undefined): EvidenceRef | undefined {
  return event === undefined ? undefined : eventRef(event);
}

/**
 * The id of an event that may be absent, as an observed JSON value.
 *
 * @example
 * idOf(view.signal); // null when Σ is absent
 */
export function idOf(event: IndexedEvent | undefined): string | null {
  return event?.record.event_id ?? null;
}

/**
 * Reasons without repeats, first occurrence kept, in their given order.
 *
 * @example
 * uniqueReasons([gap, gap, missing]); // [gap, missing]
 */
export function uniqueReasons(reasons: readonly StructuredReason[]): readonly StructuredReason[] {
  const seen = new Set<string>();
  return reasons.filter((reason) => {
    const key = JSON.stringify([
      reason.code,
      reason.subject,
      reason.artifact_path ?? '',
      reason.event_id ?? '',
      reason.detail,
    ]);
    const fresh = !seen.has(key);
    seen.add(key);
    return fresh;
  });
}
