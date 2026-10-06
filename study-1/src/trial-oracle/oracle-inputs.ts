// The business inputs the monetary rules read besides the ledger: the payment and the approved
// decision (design §8.5 notation P, A, C, cap, R). Each is located by its class in the expected
// artifact set, so an absent input can always be named (BR-RUA-035 INPUT_MISSING with the path),
// and is present only when its document is usable.

import { artifactRef } from '../evidence-ingestion/gate-assessment.ts';
import type { IngestedEvidence } from '../evidence-ingestion/ingestion-model.ts';
import { PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import type { EvidenceUnit } from '../evidence-package/package-layout.ts';
import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import type { StructuredReason } from '../record-contract/primitives.ts';
import type { ApprovedDecision } from '../record-contract/records/group-a/approved_decision.ts';
import type { Payment } from '../record-contract/records/group-a/payment.ts';

export type BusinessInputClass = 'payment' | 'approved_decision';

/** One business input: where it should be, its reference when given, and its usable document. */
export interface BusinessInputState<T> {
  readonly artifact_class: BusinessInputClass;
  readonly path: string;
  readonly ref?: EvidenceRef;
  readonly record?: T;
}

/** The payment and approved decision of the evaluated trial. */
export interface BusinessInputs {
  readonly payment: BusinessInputState<Payment>;
  readonly decision: BusinessInputState<ApprovedDecision>;
}

const LAYOUT_FILES = { payment: 'payment', approved_decision: 'approvedDecision' } as const;

/**
 * The payment and approved decision states of a trial's evidence.
 *
 * @example
 * businessInputs(evidence).decision.record?.refund_request_id; // 'ref-poc-001'
 */
export function businessInputs(evidence: IngestedEvidence): BusinessInputs {
  return {
    payment: inputState(evidence, 'payment', evidence.observations.payment?.record),
    decision: inputState(evidence, 'approved_decision', evidence.observations.approved_decision?.record),
  };
}

/**
 * The INPUT_MISSING reason of an absent input, located at its expected path (BR-RUA-035).
 *
 * @example
 * inputMissingReason(inputs.payment, 'BR-RUA-002').code; // 'INPUT_MISSING'
 */
export function inputMissingReason(state: BusinessInputState<unknown>, subject: string): StructuredReason {
  return {
    code: 'INPUT_MISSING',
    subject,
    artifact_path: state.path,
    detail: `${state.path} has no usable ${state.artifact_class}; expected the trial's ${state.artifact_class} document`,
  };
}

function inputState<T>(
  evidence: IngestedEvidence,
  artifactClass: BusinessInputClass,
  record: T | undefined,
): BusinessInputState<T> {
  const artifact = [...evidence.artifacts.values()].find(
    (candidate) => candidate.origin === 'subject' && candidate.artifact_class === artifactClass,
  );
  return {
    artifact_class: artifactClass,
    path: artifact?.path ?? expectedPath(evidence, artifactClass),
    ...(artifact === undefined ? {} : { ref: artifactRef(artifact) }),
    ...(record === undefined ? {} : { record }),
  };
}

function expectedPath(evidence: IngestedEvidence, artifactClass: BusinessInputClass): string {
  const expected = evidence.expected.find((artifact) => artifact.artifact_class === artifactClass);
  if (expected !== undefined) {
    return expected.path;
  }
  const trial = evidence.scope.trial;
  const unit: EvidenceUnit = trial === undefined ? { kind: 'probe' } : { kind: 'trial', trial_id: trial.trial_id };
  return PACKAGE_LAYOUT.unitFile(unit, LAYOUT_FILES[artifactClass]);
}
