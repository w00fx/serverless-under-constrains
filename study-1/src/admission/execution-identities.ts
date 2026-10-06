// Admission step A11 (IDENTITY; BR-RUA-019, BR-RUA-038, BR-RUA-040, design §10.1): the execution id
// and the trial ids, in their only allowed order. A run declares its four trials in RUN_TRIAL_ORDER;
// a variant validation declares its one variant's CONTROL then COMMIT_THEN_TIMEOUT; a probe
// declares none. Every id must be a lowercase UUIDv4 and all of them, with the attempt id, must be
// distinct: a reused id would let two evidence units share an identity.

import { isUuid4 } from '../record-contract/identifiers.ts';
import { boundedText } from '../record-contract/json-value.ts';
import type { ExecutionIdentity, Uuid4, UuidSource, VariantId } from '../record-contract/primitives.ts';
import { RUN_TRIAL_ORDER, VALIDATION_SCENARIO_ORDER } from '../record-contract/records/group-a/execution_manifest.ts';
import type {
  DeclaredTrial,
  ExecutionPlan,
  SelectedQualification,
} from '../record-contract/records/group-a/execution_manifest.ts';
import type { QualificationSelection } from './admission-ports.ts';
import { admissionReason } from './admission-reason.ts';
import { failed, verdictOf } from './preflight-check.ts';
import type { CheckStatement, StepVerdict } from './preflight-check.ts';

const SUBJECT = 'BR-RUA-040';

/** What the request asks to execute, once A4 has checked its variant. */
export type ExecutionTarget =
  | { readonly kind: 'RUN' }
  | { readonly kind: 'TRANSPORT_PROBE' }
  | { readonly kind: 'VARIANT_VALIDATION'; readonly variant: VariantId };

/** What A11 declares: the identity and the plan the manifest freezes. */
export interface DeclaredExecution {
  readonly identity: ExecutionIdentity;
  readonly execution_id: Uuid4;
  readonly plan: ExecutionPlan;
}

/**
 * Step A11: draws the execution id and then the trial ids in declared order. A run or a
 * validation without a selected probe declares nothing (A10 rejects it first).
 *
 * @example
 * const verdict = declareExecution({ kind: 'RUN' }, attemptId, selection, ids);
 * if (verdict.passed) verdict.value.plan.trials.length; // 4
 */
export function declareExecution(
  target: ExecutionTarget,
  admissionAttemptId: Uuid4,
  qualification: QualificationSelection | null,
  ids: UuidSource,
): StepVerdict<DeclaredExecution> {
  const selected = qualification === null ? null : selectedQualification(qualification);
  if (target.kind !== 'TRANSPORT_PROBE' && selected === null) {
    return failed('IDENTITY', { subject: 'execution_identities', expected: 'selected_probe' }, [
      admissionReason(
        'EXECUTION_QUALIFICATION_MISSING',
        SUBJECT,
        `a ${target.kind} has no selected probe; expected one`,
      ),
    ]);
  }
  const executionId = ids.next();
  const declared =
    target.kind === 'TRANSPORT_PROBE' || selected === null
      ? probePlan(executionId)
      : qualifiedPlan(target, executionId, selected, ids);
  const trialIds = declared.plan.trials.map((trial) => trial.trial_id);
  const drawn = [admissionAttemptId, executionId, ...trialIds];
  const reasons = [
    ...drawn
      .filter((id) => !isUuid4(id))
      .map((id) =>
        admissionReason(
          'EXECUTION_ID_INVALID',
          SUBJECT,
          `generated id ${boundedText(id)} is not a lowercase UUIDv4; expected one`,
        ),
      ),
    ...drawn
      .filter((id, index) => drawn.indexOf(id) !== index)
      .map((id) =>
        admissionReason(
          'EXECUTION_ID_COLLISION',
          SUBJECT,
          `generated id ${boundedText(id)} repeats; expected distinct ids`,
        ),
      ),
  ];
  const statement: CheckStatement = {
    subject: 'execution_identities',
    expected: { trials: trialIds.length, seed: 1 },
    observed: { execution_id: boundedText(executionId), trial_ids: trialIds.map((id) => boundedText(id)) },
  };
  return verdictOf('IDENTITY', statement, reasons, declared);
}

function probePlan(executionId: Uuid4): DeclaredExecution {
  const identity = { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: executionId } as const;
  return { identity, execution_id: executionId, plan: { ...identity, trials: [], qualification: null } };
}

function qualifiedPlan(
  target: Exclude<ExecutionTarget, { readonly kind: 'TRANSPORT_PROBE' }>,
  executionId: Uuid4,
  qualification: SelectedQualification,
  ids: UuidSource,
): DeclaredExecution {
  if (target.kind === 'RUN') {
    const trials = [
      trialOf(RUN_TRIAL_ORDER[0], ids),
      trialOf(RUN_TRIAL_ORDER[1], ids),
      trialOf(RUN_TRIAL_ORDER[2], ids),
      trialOf(RUN_TRIAL_ORDER[3], ids),
    ] as const;
    const identity = { execution_kind: target.kind, run_id: executionId } as const;
    return { identity, execution_id: executionId, plan: { ...identity, trials, qualification } };
  }
  const trials = [
    trialOf({ sequence: 1, variant_id: target.variant, scenario: VALIDATION_SCENARIO_ORDER[0] }, ids),
    trialOf({ sequence: 2, variant_id: target.variant, scenario: VALIDATION_SCENARIO_ORDER[1] }, ids),
  ] as const;
  const identity = { execution_kind: target.kind, variant_validation_id: executionId } as const;
  return {
    identity,
    execution_id: executionId,
    plan: { ...identity, variant_id: target.variant, trials, qualification },
  };
}

function trialOf(trial: Omit<DeclaredTrial, 'trial_id'>, ids: UuidSource): DeclaredTrial {
  return { sequence: trial.sequence, trial_id: ids.next(), variant_id: trial.variant_id, scenario: trial.scenario };
}

// The manifest states an amendment head only when one is explicitly selected.
function selectedQualification(selection: QualificationSelection): SelectedQualification {
  const head = selection.amendment_head_sha256;
  return {
    transport_probe_id: selection.transport_probe_id,
    original_package_index_sha256: selection.original_package_index_sha256,
    ...(head === null ? {} : { amendment_head_sha256: head }),
  };
}
