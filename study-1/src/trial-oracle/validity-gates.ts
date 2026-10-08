// The nine validity gates of one trial in their fixed G1-G8 order (design §8.3, §6.3; G4 split
// into G4a for CONTROL and G4b for treatment, each `not_applicable` where the other applies).
// Ingestion owns G2, G3 and G8, treatment fidelity owns G4a and G4b, and the oracle owns G1, G5,
// G6 and G7. The settlement facts and the terminal reason are read once and shared.

import { assessEvidenceIntegrity } from '../evidence-ingestion/evidence-integrity-gate.ts';
import { assessIdentityIntegrity } from '../evidence-ingestion/identity-integrity-gate.ts';
import type { GateAssessment, IngestedEvidence } from '../evidence-ingestion/ingestion-model.ts';
import { assessTraceability } from '../evidence-ingestion/traceability-gate.ts';
import type { ValidityGate } from '../record-contract/records/group-c/oracle_result.ts';
import type { SixConditionResults } from '../record-contract/records/group-c/shared-shapes.ts';
import type { GateId } from '../record-contract/records/group-c/vocabulary.ts';
import { deriveControlIntegrity } from '../treatment-fidelity/control-integrity.ts';
import { evaluateTreatmentConditions } from '../treatment-fidelity/treatment-conditions.ts';
import { deriveTreatmentFidelity } from '../treatment-fidelity/treatment-fidelity.ts';
import type { FidelityAssessment } from '../treatment-fidelity/treatment-fidelity.ts';
import { buildTreatmentView } from '../treatment-fidelity/treatment-view.ts';
import { assessIndependentOracle } from './independent-oracle-gate.ts';
import { assessLedgerAccess } from './ledger-access-gate.ts';
import { deriveProcessingTerminalReason } from './processing-terminal-reason.ts';
import type { TerminalReasonDerivation } from './processing-terminal-reason.ts';
import { assessRuleEvidence } from './rule-evidence-gate.ts';
import { assessSettlementGate } from './settlement-gate.ts';
import { readTrialSettlement } from './trial-settlement.ts';

/** The gates in G1-G8 order, as the oracle result lists them. */
export type NineGates = readonly [
  ValidityGate,
  ValidityGate,
  ValidityGate,
  ValidityGate,
  ValidityGate,
  ValidityGate,
  ValidityGate,
  ValidityGate,
  ValidityGate,
];

/**
 * The scenario side of a trial: a CONTROL trial is judged by G4a alone; a treatment trial carries
 * its treatment fidelity (G4b) and the six conditions it was derived from.
 */
export type TreatmentAssessment =
  | { readonly scenario: 'CONTROL' }
  | {
      readonly scenario: 'COMMIT_THEN_TIMEOUT';
      readonly conditions: SixConditionResults;
      readonly fidelity: FidelityAssessment;
    };

export interface TrialGates {
  readonly gates: NineGates;
  readonly terminal: TerminalReasonDerivation;
}

/**
 * Assesses every validity gate of a trial whose scenario side is already assessed.
 *
 * @example
 * assessValidityGates(evidence, { scenario: 'CONTROL' }).gates.map((gate) => gate.value); // nine values, G1 first
 */
export function assessValidityGates(evidence: IngestedEvidence, treatment: TreatmentAssessment): TrialGates {
  const settlement = readTrialSettlement(evidence);
  const terminal = deriveProcessingTerminalReason(evidence);
  const gates: NineGates = [
    asGate(assessIndependentOracle(evidence, settlement)),
    asGate(assessTraceability(evidence)),
    asGate(assessIdentityIntegrity(evidence)),
    asGate(deriveControlIntegrity(evidence)),
    treatmentGate(treatment),
    asGate(assessLedgerAccess(evidence)),
    asGate(assessSettlementGate(settlement, terminal)),
    asGate(assessRuleEvidence(evidence)),
    asGate(assessEvidenceIntegrity(evidence)),
  ];
  return { gates, terminal };
}

/**
 * The scenario side of a trial, as the treatment view binds it: a COMMIT_THEN_TIMEOUT trial gets
 * treatment fidelity over its six conditions; a trial the view refuses is a CONTROL trial, judged
 * by G4a alone. The view refuses exactly the trials whose manifest does not name
 * COMMIT_THEN_TIMEOUT, and `evaluateTrial` refuses a trial without a usable manifest before it
 * asks, so the refusal never stands for an unknown scenario there.
 *
 * @example
 * assessTreatment(treatmentEvidence).scenario; // 'COMMIT_THEN_TIMEOUT'
 */
export function assessTreatment(evidence: IngestedEvidence): TreatmentAssessment {
  const view = buildTreatmentView(evidence);
  if (!view.ok) {
    return { scenario: 'CONTROL' };
  }
  const conditions = evaluateTreatmentConditions(view.value);
  return { scenario: 'COMMIT_THEN_TIMEOUT', conditions, fidelity: deriveTreatmentFidelity(conditions, view.value) };
}

function treatmentGate(treatment: TreatmentAssessment): ValidityGate {
  if (treatment.scenario === 'CONTROL') {
    return { gate: 'treatment_fidelity', value: 'not_applicable', reasons: [], evidence_refs: [] };
  }
  const { fidelity } = treatment;
  return {
    gate: 'treatment_fidelity',
    value: fidelity.treatment_fidelity,
    reasons: fidelity.reasons,
    evidence_refs: fidelity.evidence_refs,
  };
}

function asGate<G extends GateId>(assessment: GateAssessment<G>): ValidityGate {
  return {
    gate: assessment.gate,
    value: assessment.value,
    reasons: assessment.reasons,
    evidence_refs: assessment.evidence_refs,
  };
}
