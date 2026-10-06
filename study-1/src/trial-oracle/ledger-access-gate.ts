// Gate G5 `ledger_access` of a trial (design §8.3, BR-RUA-034, BR-RUA-037): the ledger snapshot
// must be complete, consistent and free of duplicate transaction ids. A duplicate
// `provider_transaction_id` invalidates it; a missing or unreadable snapshot, incomplete
// pagination (AC-RUA-007 case 1), or a snapshot that does not declare a consistent read leaves it
// unverified. The probe judges its own G5 the same way (evidence/WP-10/decisions.md).

import { assembleGate, reasonAt } from '../evidence-ingestion/gate-assessment.ts';
import type { GateCause } from '../evidence-ingestion/gate-assessment.ts';
import { aggregatedDetail } from '../evidence-ingestion/ingestion-findings.ts';
import type { GateAssessment, IngestedEvidence } from '../evidence-ingestion/ingestion-model.ts';
import { incompleteArtifactReason, subjectArtifactState } from '../treatment-fidelity/subject-artifacts.ts';

const SUBJECT = 'BR-RUA-034';

/**
 * Judges G5 over the trial's ledger view.
 *
 * @example
 * assessLedgerAccess(evidence).value; // 'unverified' when pagination is incomplete
 */
export function assessLedgerAccess(evidence: IngestedEvidence): GateAssessment<'ledger_access'> {
  const state = subjectArtifactState(evidence, 'ledger_snapshot');
  const ledger = evidence.ledger;
  const refs = state.ref === undefined ? [] : [state.ref];
  const snapshot = ledger.snapshot?.record;
  if (snapshot === undefined) {
    return assembleGate(
      'ledger_access',
      [{ value: 'unverified', reason: incompleteArtifactReason(state, SUBJECT), refs }],
      [],
    );
  }
  const causes: GateCause[] = [];
  const [duplicate] = ledger.duplicate_transaction_ids;
  if (duplicate !== undefined) {
    const detail = aggregatedDetail(
      `provider_transaction_id ${duplicate} appears more than once; expected unique ids`,
      ledger.duplicate_transaction_ids.length,
    );
    causes.push({
      value: 'invalid',
      reason: reasonAt(SUBJECT, 'DUPLICATE_LEDGER_TRANSACTION_ID', detail, state.ref),
      refs,
    });
  }
  // A present snapshot is complete exactly when it has no pagination problem (ledger-view.ts).
  const [problem] = ledger.pagination_problems;
  if (problem !== undefined) {
    const detail = aggregatedDetail(
      `pagination is incomplete (${problem}); expected every page read`,
      ledger.pagination_problems.length,
    );
    causes.push({
      value: 'unverified',
      reason: reasonAt(SUBJECT, 'LEDGER_PAGINATION_INCOMPLETE', detail, state.ref),
      refs,
    });
  }
  if (!snapshot.consistent_read) {
    const detail = 'the ledger snapshot declares consistent_read false; expected a consistent read';
    causes.push({
      value: 'unverified',
      reason: reasonAt(SUBJECT, 'LEDGER_READ_NOT_CONSISTENT', detail, state.ref),
      refs,
    });
  }
  return assembleGate('ledger_access', causes, refs);
}
