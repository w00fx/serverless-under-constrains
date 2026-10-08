// Ledger access of the probe, gate G5 (design §8.3): the probe ledger snapshot must be complete,
// consistent and free of duplicate transaction ids. A duplicate `provider_transaction_id`
// invalidates it (BR-RUA-034); a missing or unreadable snapshot, incomplete pagination, or a
// snapshot that does not declare a consistent read leaves it unverified. Trials judge G5 in the
// trial oracle; the probe judges it here, over the same ingestion ledger view
// (evidence/WP-10/decisions.md).

import { assembleGate, reasonAt } from '../../evidence-ingestion/gate-assessment.ts';
import type { GateCause } from '../../evidence-ingestion/gate-assessment.ts';
import type { GateAssessment, IngestedEvidence } from '../../evidence-ingestion/ingestion-model.ts';
import { incompleteArtifactReason, subjectArtifactState } from '../../treatment-fidelity/subject-artifacts.ts';

const SUBJECT = 'BR-RUA-034';

/**
 * Judges G5 over the probe's ledger view.
 *
 * @example
 * assessProbeLedgerAccess(probeEvidence).value; // 'verified' for a complete consistent snapshot
 */
export function assessProbeLedgerAccess(evidence: IngestedEvidence): GateAssessment<'ledger_access'> {
  const state = subjectArtifactState(evidence, 'ledger_snapshot');
  const ledger = evidence.ledger;
  const refs = state.ref === undefined ? [] : [state.ref];
  if (ledger.status !== 'present') {
    return assembleGate(
      'ledger_access',
      [{ value: 'unverified', reason: incompleteArtifactReason(state, SUBJECT), refs }],
      [],
    );
  }
  const at = state.ref;
  const causes: GateCause[] = ledger.duplicate_transaction_ids.map((id) => ({
    value: 'invalid',
    reason: reasonAt(
      SUBJECT,
      'DUPLICATE_LEDGER_TRANSACTION_ID',
      `provider_transaction_id ${id} appears more than once; expected unique ids`,
      at,
    ),
    refs,
  }));
  if (!ledger.pagination_complete) {
    const detail = `pagination is incomplete (${ledger.pagination_problems.join('; ')}); expected every page read`;
    causes.push({ value: 'unverified', reason: reasonAt(SUBJECT, 'LEDGER_PAGINATION_INCOMPLETE', detail, at), refs });
  }
  if (ledger.snapshot?.record.consistent_read !== true) {
    const detail = 'the ledger snapshot declares consistent_read false; expected a consistent read';
    causes.push({ value: 'unverified', reason: reasonAt(SUBJECT, 'LEDGER_READ_NOT_CONSISTENT', detail, at), refs });
  }
  return assembleGate('ledger_access', causes, refs);
}
