// Treatment fidelity, gate G4b (BR-RUA-025, design §8.3 and §8.10, D-05):
//
//   invalid     if an unaffected condition fails, a timeout-signal conflict is recorded, the
//               provider configuration is not COMMIT_THEN_TIMEOUT, the commit triple differs
//               across the commit events, the ledger and the treatment snapshot, or the first
//               accepted provider call is not the targeted one;
//   unverified  else if a safety release occurred, a condition is indeterminate (or fails on
//               affected evidence), or a required record or event is missing;
//   verified    otherwise: all six conditions pass.
//
// The basis is always `causal_plus_cross_source_clock_assumption` with CA-1: BR-RUA-010 orders by
// cross-source wall clock, never by formal happened-before proof (AC-RUA-002).

import { reasonAt } from '../evidence-ingestion/gate-assessment.ts';
import type { GateCause } from '../evidence-ingestion/gate-assessment.ts';
import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import type { StructuredReason } from '../record-contract/primitives.ts';
import type { ConditionResult } from '../record-contract/records/group-c/shared-shapes.ts';
import type {
  ApplicableGateValue,
  ClockAssumptionId,
  FidelityBasis,
} from '../record-contract/records/group-c/vocabulary.ts';
import { assembleApplicableGate } from './applicable-gate.ts';
import { TREATMENT_CLOCK_ASSUMPTION_REFS, TREATMENT_FIDELITY_BASIS } from './clock-assumption.ts';
import { refOf } from './condition-result.ts';
import { commitTripleCauses, firstAcceptedCallCauses } from './commit-binding.ts';
import { incompleteArtifactReason } from './subject-artifacts.ts';
import type { SubjectArtifactState } from './subject-artifacts.ts';
import type { TreatmentView } from './treatment-view.ts';

const SUBJECT = 'BR-RUA-025';

export interface FidelityAssessment {
  readonly treatment_fidelity: ApplicableGateValue;
  readonly fidelity_basis: Extract<FidelityBasis, 'causal_plus_cross_source_clock_assumption'>;
  readonly clock_assumption_refs: readonly ClockAssumptionId[];
  readonly reasons: readonly StructuredReason[];
  readonly evidence_refs: readonly EvidenceRef[];
}

/**
 * Derives treatment fidelity from the six conditions and the treatment view.
 *
 * @example
 * deriveTreatmentFidelity(evaluateTreatmentConditions(view), view).treatment_fidelity; // 'verified'
 */
export function deriveTreatmentFidelity(
  conditions: readonly ConditionResult[],
  view: TreatmentView,
): FidelityAssessment {
  const causes = [
    ...conditions.flatMap(conditionCauses),
    ...conflictCauses(view),
    ...configurationCauses(view),
    ...commitTripleCauses(view),
    ...firstAcceptedCallCauses(view),
    ...safetyCauses(view),
    ...missingRecordCauses(view),
  ];
  const verifiedRefs = [
    ...conditions.flatMap((condition) => condition.evidence_refs),
    ...[view.configuration_state.ref, view.snapshot_state.ref].filter((ref) => ref !== undefined),
  ];
  const gate = assembleApplicableGate('treatment_fidelity', causes, verifiedRefs);
  return {
    treatment_fidelity: gate.value,
    fidelity_basis: TREATMENT_FIDELITY_BASIS,
    clock_assumption_refs: TREATMENT_CLOCK_ASSUMPTION_REFS,
    reasons: gate.reasons,
    evidence_refs: gate.evidence_refs,
  };
}

// An unaffected fail invalidates; an indeterminate result, or a fail on affected evidence, leaves
// fidelity unverified.
function conditionCauses(condition: ConditionResult): readonly GateCause[] {
  if (condition.result === 'pass') {
    return [];
  }
  const refs = condition.evidence_refs;
  if (condition.result === 'fail' && condition.affected_by.length === 0) {
    const detail = `${condition.condition_id} fails on unaffected evidence; expected pass`;
    return [{ value: 'invalid', reason: reasonAt(condition.condition_id, 'CONDITION_FAILED', detail, refs[0]), refs }];
  }
  const causes = [...condition.affected_by, ...condition.indeterminate_reasons.map((reason) => reason.code)];
  const detail = `${condition.condition_id} is ${condition.result} (${[...new Set(causes)].join(', ')}); expected pass`;
  return [
    { value: 'unverified', reason: reasonAt(condition.condition_id, 'CONDITION_INDETERMINATE', detail, refs[0]), refs },
  ];
}

function conflictCauses(view: TreatmentView): readonly GateCause[] {
  return view.conflicts.map((conflict) => {
    const detail = `timeout_signal_conflict_recorded for caller event ${conflict.record.caller_timeout_event_id} against ${conflict.record.existing_caller_event_id}; expected no conflicting control evidence`;
    const ref = refOf(conflict);
    return {
      value: 'invalid',
      reason: reasonAt(SUBJECT, 'TIMEOUT_SIGNAL_CONFLICT', detail, ref),
      refs: [ref].filter((r) => r !== undefined),
    };
  });
}

function configurationCauses(view: TreatmentView): readonly GateCause[] {
  const configuration = view.configuration;
  const ref = view.configuration_state.ref;
  if (configuration === undefined) {
    return [missingCause(view.configuration_state)];
  }
  if (configuration.record.scenario === 'COMMIT_THEN_TIMEOUT') {
    return [];
  }
  const detail = `provider configuration declares scenario ${configuration.record.scenario}; expected COMMIT_THEN_TIMEOUT`;
  return [
    {
      value: 'invalid',
      reason: reasonAt(SUBJECT, 'SCENARIO_MISMATCH', detail, ref),
      refs: ref === undefined ? [] : [ref],
    },
  ];
}

function safetyCauses(view: TreatmentView): readonly GateCause[] {
  const snapshot = view.snapshot?.record;
  const snapshotReleased = snapshot?.item_present === true && snapshot.treatment.state === 'SAFETY_RELEASED';
  if (view.safety_releases.length === 0 && !snapshotReleased) {
    return [];
  }
  const refs = [...view.safety_releases.map(refOf), snapshotReleased ? view.snapshot_state.ref : undefined].filter(
    (ref) => ref !== undefined,
  );
  const detail = `${String(view.safety_releases.length)} treatment_safety_released event(s), treatment state ${snapshotReleased ? 'SAFETY_RELEASED' : 'not released'}; expected no safety release`;
  return [{ value: 'unverified', reason: reasonAt(SUBJECT, 'SAFETY_RELEASED', detail, refs[0]), refs }];
}

function missingRecordCauses(view: TreatmentView): readonly GateCause[] {
  const causes: GateCause[] = [];
  if (view.snapshot === undefined) {
    causes.push(missingCause(view.snapshot_state));
  }
  if (view.commit === undefined) {
    const detail = `${String(view.targeted_commits.length)} targeted provider_transaction_committed event(s); expected exactly one`;
    const ref = view.journals.provider.ref;
    causes.push({
      value: 'unverified',
      reason: reasonAt(SUBJECT, 'TARGETED_COMMIT_NOT_UNIQUE', detail, ref),
      refs: ref === undefined ? [] : [ref],
    });
  }
  return causes;
}

function missingCause(state: SubjectArtifactState): GateCause {
  return {
    value: 'unverified',
    reason: incompleteArtifactReason(state, SUBJECT),
    refs: state.ref === undefined ? [] : [state.ref],
  };
}
