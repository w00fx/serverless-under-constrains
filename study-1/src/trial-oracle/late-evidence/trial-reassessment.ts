// Reassessing one frozen trial with the late records (design §8.13, D-16): ingest the frozen
// artifacts plus the late records that belong in them, re-run `evaluateTrial` and compare the
// verdict projections. A trial-scoped late record joins only its trial's evidence; a record of an
// execution-level file joins every trial's evidence, because every trial's evidence holds that
// file. Only records that name the trial, or no trial at all, count as late evidence of the trial:
// with none of them the trial has no late evidence and is not re-evaluated. A change counts against
// the late records only when the frozen evidence alone still re-evaluates to the frozen result's
// projection; otherwise the difference has another cause (other evidence than was frozen, another
// ingestion context or oracle revision), and the reassessment is refused rather than reported as a
// contradiction (BR-RUA-043 "Late evidence never modifies frozen results"; D-16).

import { ingestEvidence } from '../../evidence-ingestion/ingest-evidence.ts';
import { aggregatedDetail } from '../../evidence-ingestion/ingestion-findings.ts';
import type { IngestionInput } from '../../evidence-ingestion/ingestion-model.ts';
import { boundedJsonText } from '../../record-contract/json-value.ts';
import { err, ok } from '../../record-contract/primitives.ts';
import type { Result, StructuredReason, UtcMillis } from '../../record-contract/primitives.ts';
import type { RecordValidator } from '../../record-contract/schema-registry.ts';
import type {
  FrozenResultReassessment,
  ProjectionChange,
} from '../../record-contract/records/group-c/late_evidence_assessment.ts';
import { evaluateTrial } from '../evaluate-trial.ts';
import { verdictProjection } from '../verdict-projection.ts';
import type { VerdictProjection } from '../verdict-projection.ts';
import { augmentFrozenEvidence } from './frozen-augmentation.ts';
import type { FrozenTrial } from './frozen-results.ts';
import { LATE_EVIDENCE_SUBJECT } from './late-evidence-reasons.ts';
import type { LateProblem } from './late-evidence-reasons.ts';
import type { AcceptedLateRecord } from './late-stream-reading.ts';
import { projectionChanges } from './projection-changes.ts';

/** What re-evaluating one trial found, before monitoring decides what it may conclude. */
export interface TrialReevaluation {
  readonly trial: FrozenTrial;
  /** The late records that count as the trial's late evidence. */
  readonly counted: number;
  readonly changes: readonly ProjectionChange[];
  readonly problems: readonly LateProblem[];
}

/**
 * Re-evaluates one frozen trial with the late records that belong in its evidence, or why the
 * re-evaluation was refused. `checked_at` of the re-evaluation is the assessment instant.
 *
 * @example
 * const reevaluation = reevaluateTrial(trial, accepted, assessedAt, validator);
 * if (reevaluation.ok) reevaluation.value.changes; // [] when the verdict projection is unchanged
 */
export function reevaluateTrial(
  trial: FrozenTrial,
  accepted: readonly AcceptedLateRecord[],
  assessedAt: UtcMillis,
  validator: RecordValidator,
): Result<TrialReevaluation, readonly StructuredReason[]> {
  const trialId = trial.result.trial_id;
  const joining = accepted.filter(({ record, route }) => record.trial_id === trialId || route.shared);
  const counted = joining.filter(({ record }) => record.trial_id === undefined || record.trial_id === trialId).length;
  if (counted === 0) {
    return ok({ trial, counted, changes: [], problems: [] });
  }
  const augmented = augmentFrozenEvidence(trial.frozen, joining, validator);
  const projections = reevaluatedProjections(trial, [trial.frozen, augmented.input], assessedAt, validator);
  if (!projections.ok) {
    return projections;
  }
  // One projection per input, in input order.
  const [baseline, reassessed] = projections.value as readonly [VerdictProjection, VerdictProjection];
  const frozen = verdictProjection(trial.result);
  const unexplained = projectionChanges(frozen, baseline);
  const [first] = unexplained;
  if (first !== undefined) {
    const difference = `${first.field} ${boundedJsonText(first.reassessed)} where the frozen result holds ${boundedJsonText(first.frozen)}`;
    const detail = `the frozen evidence alone re-evaluates to ${aggregatedDetail(difference, unexplained.length)}; expected it to reproduce the frozen result's verdict projection`;
    return err([refusal(trial, 'FROZEN_RESULT_NOT_REPRODUCED', detail)]);
  }
  return ok({ trial, counted, changes: projectionChanges(frozen, reassessed), problems: augmented.problems });
}

// The verdict projection of each input re-evaluated at the assessment instant, in order, or the
// refusal of the first input the oracle refuses or finds of another trial than the frozen result's.
// The frozen and the augmented input hold the same manifests (augmentation joins only journals,
// observations and re-captured snapshots), so they name one execution and trial: the oracle refuses
// both or neither, and one refusal check covers both.
function reevaluatedProjections(
  trial: FrozenTrial,
  inputs: readonly IngestionInput[],
  assessedAt: UtcMillis,
  validator: RecordValidator,
): Result<readonly VerdictProjection[], readonly StructuredReason[]> {
  const projections: VerdictProjection[] = [];
  for (const input of inputs) {
    const evaluation = evaluateTrial({ evidence: ingestEvidence(input, validator), checked_at: assessedAt });
    if (!evaluation.ok) {
      return err(
        evaluation.error.map((reason) => refusal(trial, 'REEVALUATION_REFUSED', `${reason.code}: ${reason.detail}`)),
      );
    }
    const { result } = evaluation.value;
    if (result.trial_id !== trial.result.trial_id) {
      const detail = `the frozen evidence names trial ${result.trial_id}; expected trial ${trial.result.trial_id} of the frozen result`;
      return err([refusal(trial, 'REEVALUATION_TRIAL_MISMATCH', detail)]);
    }
    projections.push(verdictProjection(result));
  }
  return ok(projections);
}

/**
 * The status of one reassessment: with complete monitoring, `none`, `consistent` or
 * `contradictory`; otherwise a change is still `contradictory` and anything else `unverified`.
 *
 * @example
 * reassessmentOf(reevaluation, true).status; // 'consistent' when late records changed nothing
 */
export function reassessmentOf(reevaluation: TrialReevaluation, monitoringComplete: boolean): FrozenResultReassessment {
  const { trial, counted, changes } = reevaluation;
  return {
    frozen_result_ref: trial.result_ref,
    trial_id: trial.result.trial_id,
    status: reassessmentStatus(counted, changes.length, monitoringComplete),
    changes,
  };
}

function reassessmentStatus(
  counted: number,
  changed: number,
  monitoringComplete: boolean,
): FrozenResultReassessment['status'] {
  if (changed > 0) {
    return 'contradictory';
  }
  if (!monitoringComplete) {
    return 'unverified';
  }
  return counted === 0 ? 'none' : 'consistent';
}

function refusal(trial: FrozenTrial, code: string, detail: string): StructuredReason {
  return { code, subject: LATE_EVIDENCE_SUBJECT, artifact_path: trial.result_ref.artifact_path, detail };
}
