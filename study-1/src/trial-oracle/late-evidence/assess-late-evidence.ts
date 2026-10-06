// The late-evidence assessment of one run or variant validation (BR-RUA-043, design §5.3
// `assessLateEvidence`, §8.13, D-16, AC-RUA-030), frozen as
// `late-evidence/late-evidence-assessment.json` at cleanup step 2:
//   late stream -> accepted correlated records and late problems
//   each frozen trial -> frozen evidence plus its late records -> evaluateTrial -> projection changes
//   declared monitoring, its window and the problems -> effective monitoring
//   -> each reassessment's status -> the late-evidence status
// `none` means no correlated late record, `consistent` that every re-evaluation kept its verdict
// projection, `contradictory` that one changed, and `unverified` that monitoring was shortened,
// skipped or failed. Pure and total: the frozen inputs are only read, the instant is injected, and
// input it cannot assess is refused with the reasons instead of throwing (Owner amendment A-05).

import { EXECUTION_PATHS } from '../../evidence-package/package-layout.ts';
import { aggregatedDetail } from '../../evidence-ingestion/ingestion-findings.ts';
import { sha256Hex } from '../../record-contract/digests.ts';
import { boundedJsonText } from '../../record-contract/json-value.ts';
import { err, ok } from '../../record-contract/primitives.ts';
import type { JsonValue, Result, StructuredReason } from '../../record-contract/primitives.ts';
import type { RecordValidator } from '../../record-contract/schema-registry.ts';
import type {
  FrozenResultReassessment,
  LateEvidenceAssessment,
  MonitoringOutcome,
} from '../../record-contract/records/group-c/late_evidence_assessment.ts';
import type { TrialExecutionIdentity } from '../../record-contract/records/group-c/shared-shapes.ts';
import { readFrozenTrials } from './frozen-results.ts';
import type { LateEvidenceInput } from './late-evidence-input.ts';
import { LATE_EVIDENCE_SUBJECT, describeFirstViolation } from './late-evidence-reasons.ts';
import type { LateProblem } from './late-evidence-reasons.ts';
import { readLateStream } from './late-stream-reading.ts';
import type { AcceptedLateRecord } from './late-stream-reading.ts';
import { effectiveMonitoring, monitoringWindow } from './monitoring-outcome.ts';
import type { EffectiveMonitoring } from './monitoring-outcome.ts';
import { reassessmentOf, reevaluateTrial } from './trial-reassessment.ts';
import type { TrialReevaluation } from './trial-reassessment.ts';

/**
 * Assesses the late evidence of one execution's frozen trials, or refuses with the reasons when a
 * frozen result, the monitoring window, the stream's place or a re-evaluation cannot be assessed.
 *
 * @example
 * const assessment = assessLateEvidence(
 *   { execution: { run_id }, execution_manifest_sha256, monitoring, stream, trials, assessed_at },
 *   createRecordValidator(),
 * );
 * if (assessment.ok) assessment.value.late_evidence_status; // 'none' | 'consistent' | 'contradictory' | 'unverified'
 */
export function assessLateEvidence(
  input: LateEvidenceInput,
  validator: RecordValidator,
): Result<LateEvidenceAssessment, readonly StructuredReason[]> {
  const window = monitoringWindow(input.monitoring);
  if (!window.ok) {
    return err([window.error]);
  }
  const misplaced = misplacedStream(input);
  if (misplaced !== undefined) {
    return err([misplaced]);
  }
  const trials = readFrozenTrials(input.trials, input, validator);
  if (!trials.ok) {
    return trials;
  }
  const trialManifests = new Map(
    trials.value.map((trial) => [trial.result.trial_id, trial.result.trial_manifest_sha256] as const),
  );
  const reading = readLateStream(input.stream, { ...input, trial_manifests: trialManifests }, validator);
  const reevaluations: TrialReevaluation[] = [];
  for (const trial of trials.value) {
    const reevaluation = reevaluateTrial(trial, reading.accepted, input.assessed_at, validator);
    if (!reevaluation.ok) {
      return reevaluation;
    }
    reevaluations.push(reevaluation.value);
  }
  const problems: readonly LateProblem[] = [
    ...missingStream(input),
    ...reading.problems,
    ...reevaluations.flatMap((reevaluation) => reevaluation.problems),
  ];
  const monitoring = effectiveMonitoring(input.monitoring.outcome, window.value, problems);
  const reassessments = reevaluations.map((reevaluation) =>
    reassessmentOf(reevaluation, monitoring.outcome === 'complete'),
  );
  const assessment = {
    schema_version: 1,
    record_type: 'late_evidence_assessment',
    ...executionFields(input.execution),
    execution_manifest_sha256: input.execution_manifest_sha256,
    ...monitoringFields(monitoring, reading.accepted.length, reassessments),
    correlated_record_count: reading.accepted.length,
    reassessments,
    reasons: [...monitoring.reasons, ...withoutFrozenResult(reading.accepted, trialManifests)],
    evidence_refs:
      input.stream === undefined
        ? []
        : [{ artifact_path: input.stream.path, artifact_sha256: sha256Hex(input.stream.bytes) }],
    assessed_at: input.assessed_at,
  };
  return conforming(assessment as unknown as JsonValue, validator);
}

function misplacedStream(input: LateEvidenceInput): StructuredReason | undefined {
  const path = input.stream?.path;
  if (path === undefined || path === EXECUTION_PATHS.lateEvidenceStream) {
    return undefined;
  }
  const detail = `the late stream is at ${boundedJsonText(path)}; expected ${EXECUTION_PATHS.lateEvidenceStream}`;
  return { code: 'LATE_STREAM_MISPLACED', subject: LATE_EVIDENCE_SUBJECT, detail };
}

// A monitoring that ran but wrote no stream left no evidence of what it observed.
function missingStream(input: LateEvidenceInput): readonly LateProblem[] {
  if (input.stream !== undefined || input.monitoring.outcome === 'skipped') {
    return [];
  }
  const detail = `monitoring was ${input.monitoring.outcome} but ${EXECUTION_PATHS.lateEvidenceStream} is absent; expected the stream, empty when nothing was observed`;
  return [{ code: 'LATE_STREAM_MISSING', artifact_path: EXECUTION_PATHS.lateEvidenceStream, detail }];
}

function executionFields(execution: TrialExecutionIdentity): TrialExecutionIdentity {
  return execution.run_id === undefined
    ? { variant_validation_id: execution.variant_validation_id }
    : { run_id: execution.run_id };
}

function monitoringFields(
  monitoring: EffectiveMonitoring,
  correlated: number,
  reassessments: readonly FrozenResultReassessment[],
): MonitoringOutcome & { readonly monitoring_started_at?: string; readonly monitoring_ended_at?: string } {
  const { started_at: started, ended_at: ended } = monitoring.window;
  const window = {
    ...(started === undefined ? {} : { monitoring_started_at: started }),
    ...(ended === undefined ? {} : { monitoring_ended_at: ended }),
  };
  if (monitoring.outcome !== 'complete') {
    return { monitoring: monitoring.outcome, late_evidence_status: 'unverified', ...window };
  }
  if (correlated === 0) {
    return { monitoring: 'complete', late_evidence_status: 'none', ...window };
  }
  const contradicted = reassessments.some((reassessment) => reassessment.status === 'contradictory');
  return { monitoring: 'complete', late_evidence_status: contradicted ? 'contradictory' : 'consistent', ...window };
}

// A correlated record of a trial that has no frozen result counts as late evidence of the
// execution, but no frozen result can be reassessed with it.
function withoutFrozenResult(
  accepted: readonly AcceptedLateRecord[],
  trialManifests: ReadonlyMap<string, unknown>,
): readonly StructuredReason[] {
  const orphans = accepted.filter(
    ({ record }) => record.trial_id !== undefined && !trialManifests.has(record.trial_id),
  );
  const [first] = orphans;
  if (first === undefined) {
    return [];
  }
  const detail = `late stream line ${String(first.line_number)} names trial ${String(first.record.trial_id)}, which has no frozen result; expected a trial with a frozen oracle result`;
  return [
    {
      code: 'LATE_RECORD_WITHOUT_FROZEN_RESULT',
      subject: LATE_EVIDENCE_SUBJECT,
      artifact_path: EXECUTION_PATHS.lateEvidenceStream,
      detail: aggregatedDetail(detail, orphans.length),
    },
  ];
}

// The assessment is checked against its own schema, so input it cannot represent, such as a
// malformed identity or instant, is refused rather than frozen.
function conforming(
  assessment: JsonValue,
  validator: RecordValidator,
): Result<LateEvidenceAssessment, readonly StructuredReason[]> {
  const validation = validator.validateAs('late_evidence_assessment', assessment);
  if (validation.valid) {
    return ok(validation.record as LateEvidenceAssessment);
  }
  const why = describeFirstViolation(validation.violations);
  return err([
    {
      code: 'ASSESSMENT_SCHEMA_INVALID',
      subject: LATE_EVIDENCE_SUBJECT,
      detail: `${why}; expected a valid late_evidence_assessment`,
    },
  ]);
}
