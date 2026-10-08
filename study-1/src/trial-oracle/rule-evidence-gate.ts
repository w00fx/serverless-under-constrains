// Gate G7 `rule_evidence` (BR-RUA-029, design §8.3): every input of every applicable business
// rule is present and ungapped: the payment and decision (BR-RUA-002, -009), the caller journal
// (BR-RUA-003, -004) and the ledger snapshot (BR-RUA-001, -002, -009). An absent or gapped
// journal (AC-RUA-007 case 3), an absent ledger, or a missing payment or decision leaves the gate
// unverified; nothing makes it invalid.

import { assembleGate } from '../evidence-ingestion/gate-assessment.ts';
import type { GateCause } from '../evidence-ingestion/gate-assessment.ts';
import type { GateAssessment, IngestedEvidence } from '../evidence-ingestion/ingestion-model.ts';
import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import { incompleteArtifactReason, subjectArtifactState } from '../treatment-fidelity/subject-artifacts.ts';
import type { SubjectArtifactState } from '../treatment-fidelity/subject-artifacts.ts';
import { businessInputs, inputMissingReason } from './oracle-inputs.ts';
import type { BusinessInputState } from './oracle-inputs.ts';

const SUBJECT = 'BR-RUA-029';

/**
 * Judges G7 over the business rules' inputs.
 *
 * @example
 * assessRuleEvidence(evidence).value; // 'unverified' when the caller journal is absent
 */
export function assessRuleEvidence(evidence: IngestedEvidence): GateAssessment<'rule_evidence'> {
  const caller = subjectArtifactState(evidence, 'caller_journal');
  const ledger = subjectArtifactState(evidence, 'ledger_snapshot');
  const inputs = businessInputs(evidence);
  const causes: GateCause[] = [
    ...artifactCauses(caller, caller.complete),
    ...artifactCauses(ledger, evidence.ledger.snapshot !== undefined),
    ...inputCauses(inputs.payment),
    ...inputCauses(inputs.decision),
  ];
  const verified = [caller.ref, ledger.ref, inputs.payment.ref, inputs.decision.ref].filter(
    (ref): ref is EvidenceRef => ref !== undefined,
  );
  return assembleGate('rule_evidence', causes, verified);
}

function artifactCauses(state: SubjectArtifactState, usable: boolean): readonly GateCause[] {
  if (usable) {
    return [];
  }
  return [
    {
      value: 'unverified',
      reason: incompleteArtifactReason(state, SUBJECT),
      refs: state.ref === undefined ? [] : [state.ref],
    },
  ];
}

function inputCauses(state: BusinessInputState<unknown>): readonly GateCause[] {
  if (state.record !== undefined) {
    return [];
  }
  return [
    {
      value: 'unverified',
      reason: inputMissingReason(state, SUBJECT),
      refs: state.ref === undefined ? [] : [state.ref],
    },
  ];
}
