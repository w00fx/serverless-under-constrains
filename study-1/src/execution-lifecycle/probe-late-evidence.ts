// The late-evidence assessment of a transport probe (BR-RUA-043, D-16, AC-RUA-030; design §8.13,
// §10.4 steps 1-2 of a probe), frozen as `late-evidence/late-evidence-assessment.json`:
//   late stream -> accepted correlated probe records and late problems
//   frozen probe evidence plus its late records -> buildProbeResult -> probe projection changes
//   declared monitoring, its window and the problems -> effective monitoring -> late-evidence status
// It mirrors the trial assessment (trial-oracle/late-evidence), which cannot re-derive a probe
// result (design §5.4 layers): `none` means no correlated late record, `consistent` that the
// re-derived result kept the frozen probe projection, `contradictory` that it changed, and
// `unverified` that monitoring was shortened, skipped or failed. A change counts against the late
// records only when the frozen evidence alone re-derives the frozen projection; otherwise the
// reassessment is refused (FROZEN_RESULT_NOT_REPRODUCED). A correlated record with no frozen probe
// result is late evidence of the probe without a result to reassess: `consistent`, with the
// informational LATE_RECORD_WITHOUT_FROZEN_RESULT (the decision-57 rule for trials). Pure and
// total: input it cannot assess is refused with the reasons, never thrown (A-05).

import { ingestEvidence } from '../evidence-ingestion/ingest-evidence.ts';
import type { IngestionInput, RawArtifact } from '../evidence-ingestion/ingestion-model.ts';
import { EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import { boundedJsonText } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type {
  JsonObject,
  JsonValue,
  Result,
  Sha256Hex,
  StructuredReason,
  Uuid4,
  UtcMillis,
} from '../record-contract/primitives.ts';
import type {
  FrozenResultReassessment,
  LateEvidenceAssessment,
  ProjectionChange,
} from '../record-contract/records/group-c/late_evidence_assessment.ts';
import type { TransportProbeResult } from '../record-contract/records/group-c/transport_probe_result.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { buildProbeResult } from '../transport-qualification/verdict/probe-result.ts';
import { augmentFrozenEvidence } from '../trial-oracle/late-evidence/frozen-augmentation.ts';
import type { LateMonitoring } from '../trial-oracle/late-evidence/late-evidence-input.ts';
import { LATE_EVIDENCE_SUBJECT, describeFirstViolation } from '../trial-oracle/late-evidence/late-evidence-reasons.ts';
import type { LateProblem } from '../trial-oracle/late-evidence/late-evidence-reasons.ts';
import type { AcceptedLateRecord } from '../trial-oracle/late-evidence/late-stream-reading.ts';
import { effectiveMonitoring, monitoringWindow } from '../trial-oracle/late-evidence/monitoring-outcome.ts';
import type { EffectiveMonitoring } from '../trial-oracle/late-evidence/monitoring-outcome.ts';
import type { FrozenProbeEvidence } from './frozen-probe-input.ts';
import { readProbeLateStream } from './probe-late-stream.ts';

/** Everything one probe's late-evidence assessment reads. */
export interface ProbeLateEvidenceInput {
  readonly transport_probe_id: Uuid4;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly monitoring: LateMonitoring;
  /** `late-evidence/late-evidence-stream.jsonl`; absent when no stream was written. */
  readonly stream?: RawArtifact;
  /** The probe's frozen evidence and result; absent when P5 froze no result. */
  readonly probe?: FrozenProbeEvidence;
  readonly assessed_at: UtcMillis;
}

/** The frozen probe result, read from its exact stored bytes. */
interface FrozenProbe {
  readonly frozen: IngestionInput;
  readonly result: TransportProbeResult;
  readonly ref: { readonly artifact_path: string; readonly artifact_sha256: Sha256Hex };
}

/** What re-deriving the probe result found. */
interface ProbeReevaluation {
  readonly counted: number;
  readonly changes: readonly ProjectionChange[];
  readonly problems: readonly LateProblem[];
}

/**
 * Assesses the late evidence of one probe, or refuses with the reasons when the frozen result,
 * the monitoring window, the stream's place or the re-derivation cannot be assessed.
 *
 * @example
 * const assessment = assessProbeLateEvidence({ transport_probe_id, execution_manifest_sha256, monitoring,
 *   stream, probe, assessed_at }, validator);
 * if (assessment.ok) assessment.value.late_evidence_status; // 'none' | 'consistent' | 'contradictory' | 'unverified'
 */
export function assessProbeLateEvidence(
  input: ProbeLateEvidenceInput,
  validator: RecordValidator,
): Result<LateEvidenceAssessment, readonly StructuredReason[]> {
  const window = monitoringWindow(input.monitoring);
  const misplaced = misplacedStream(input.stream);
  const probe = input.probe === undefined ? ok(undefined) : readFrozenProbe(input.probe, input, validator);
  if (!window.ok || misplaced !== undefined || !probe.ok) {
    return err([
      ...(window.ok ? [] : [window.error]),
      ...(misplaced === undefined ? [] : [misplaced]),
      ...(probe.ok ? [] : [probe.error]),
    ]);
  }
  const reading = readProbeLateStream(input.stream, input, validator);
  const reevaluation =
    probe.value === undefined
      ? ok({ counted: 0, changes: [], problems: [] })
      : reevaluateProbe(probe.value, reading.accepted, input.assessed_at, validator);
  if (!reevaluation.ok) {
    return reevaluation;
  }
  const problems = [...missingStream(input), ...reading.problems, ...reevaluation.value.problems];
  const monitoring = effectiveMonitoring(input.monitoring.outcome, window.value, problems);
  const complete = monitoring.outcome === 'complete';
  const reassessments: readonly FrozenResultReassessment[] =
    probe.value === undefined
      ? []
      : [
          {
            frozen_result_ref: probe.value.ref,
            status: reassessmentStatus(reevaluation.value, complete),
            changes: reevaluation.value.changes,
          },
        ];
  const assessment = {
    schema_version: 1,
    record_type: 'late_evidence_assessment',
    transport_probe_id: input.transport_probe_id,
    execution_manifest_sha256: input.execution_manifest_sha256,
    ...monitoringFields(monitoring, reading.accepted.length, reassessments),
    correlated_record_count: reading.accepted.length,
    reassessments,
    reasons: [...monitoring.reasons, ...withoutFrozenResult(reading.accepted, probe.value)],
    evidence_refs:
      input.stream === undefined
        ? []
        : [{ artifact_path: input.stream.path, artifact_sha256: sha256Hex(input.stream.bytes) }],
    assessed_at: input.assessed_at,
  };
  return conforming(assessment as unknown as JsonValue, validator);
}

/**
 * Every probe-projection field whose value differs (D-16 for the probe): the verdict, the
 * validity, the integrity and fidelity gates, the observed cardinality and each condition's id and
 * result, named by JSON Pointer into the transport probe result.
 *
 * @example
 * probeProjectionChanges(frozenPass, reassessedFail); // [{ field: '/transport_probe_verdict', frozen: 'pass', reassessed: 'fail' }, …]
 */
export function probeProjectionChanges(
  frozen: TransportProbeResult,
  reassessed: TransportProbeResult,
): readonly ProjectionChange[] {
  const before = probeProjection(frozen);
  const after = probeProjection(reassessed);
  const fields = [...new Set([...before.keys(), ...after.keys()])];
  return fields.flatMap((field) => {
    const frozenValue = before.get(field) ?? null;
    const reassessedValue = after.get(field) ?? null;
    return frozenValue === reassessedValue ? [] : [{ field, frozen: frozenValue, reassessed: reassessedValue }];
  });
}

// Every projected value is a string or a number, so `===` compares them exactly.
function probeProjection(result: TransportProbeResult): ReadonlyMap<string, JsonValue> {
  const cardinality = result.probe_cardinality;
  const fields = new Map<string, JsonValue>([
    ['/transport_probe_verdict', result.transport_probe_verdict],
    ['/probe_validity', result.probe_validity],
    ['/evidence_integrity', result.evidence_integrity],
    ['/treatment_fidelity', result.treatment_fidelity],
    ['/probe_cardinality/caller_invocations', cardinality.caller_invocations],
    ['/probe_cardinality/accepted_provider_calls', cardinality.accepted_provider_calls],
    ['/probe_cardinality/committed_transactions', cardinality.committed_transactions],
  ]);
  result.condition_results.forEach((condition, index) => {
    fields.set(`/condition_results/${String(index)}/condition_id`, condition.condition_id);
    fields.set(`/condition_results/${String(index)}/result`, condition.result);
  });
  return fields;
}

function readFrozenProbe(
  probe: FrozenProbeEvidence,
  input: ProbeLateEvidenceInput,
  validator: RecordValidator,
): Result<FrozenProbe, StructuredReason> {
  const { path, bytes } = probe.result;
  const parsed = parseJsonDocument(bytes);
  const checked = parsed.ok ? validator.validateAs('transport_probe_result', parsed.value) : undefined;
  if (checked?.valid !== true) {
    const why = checked === undefined ? 'is not one UTF-8 JSON document' : describeFirstViolation(checked.violations);
    return err(refusal('FROZEN_RESULT_UNREADABLE', path, `${path} ${why}; expected a valid transport_probe_result`));
  }
  const result = checked.record as TransportProbeResult;
  if (
    result.transport_probe_id !== input.transport_probe_id ||
    result.execution_manifest_sha256 !== input.execution_manifest_sha256
  ) {
    const detail = `${path} names probe ${result.transport_probe_id} of manifest ${result.execution_manifest_sha256}; expected probe ${input.transport_probe_id} of manifest ${input.execution_manifest_sha256}`;
    return err(refusal('FROZEN_RESULT_FOREIGN', path, detail));
  }
  return ok({ frozen: probe.frozen, result, ref: { artifact_path: path, artifact_sha256: sha256Hex(bytes) } });
}

// Re-derives the probe result from the frozen evidence alone and with the late records; refused
// when the frozen evidence alone no longer reproduces the frozen projection.
function reevaluateProbe(
  probe: FrozenProbe,
  accepted: readonly AcceptedLateRecord[],
  assessedAt: UtcMillis,
  validator: RecordValidator,
): Result<ProbeReevaluation, readonly StructuredReason[]> {
  if (accepted.length === 0) {
    return ok({ counted: 0, changes: [], problems: [] });
  }
  const augmented = augmentFrozenEvidence(probe.frozen, accepted, validator);
  // Late records only join journals and the ledger, never the scope the derivation is refused on,
  // so both derivations succeed or fail together; every reason is kept either way.
  const derived = [probe.frozen, augmented.input].map((input) => rederived(probe, input, assessedAt, validator));
  const refused = derived.flatMap((result) => (result.ok ? [] : result.error));
  const [baseline, reassessed] = derived;
  if (baseline?.ok !== true || reassessed?.ok !== true) {
    return err(refused);
  }
  const unexplained = probeProjectionChanges(probe.result, baseline.value);
  const [first] = unexplained;
  if (first !== undefined) {
    const detail = `the frozen evidence alone re-derives ${first.field} ${boundedJsonText(first.reassessed)} where the frozen result holds ${boundedJsonText(first.frozen)} (${String(unexplained.length)} field(s) differ); expected it to reproduce the frozen probe projection`;
    return err([refusal('FROZEN_RESULT_NOT_REPRODUCED', probe.ref.artifact_path, detail)]);
  }
  return ok({
    counted: accepted.length,
    changes: probeProjectionChanges(probe.result, reassessed.value),
    problems: augmented.problems,
  });
}

function rederived(
  probe: FrozenProbe,
  input: IngestionInput,
  assessedAt: UtcMillis,
  validator: RecordValidator,
): Result<TransportProbeResult, readonly StructuredReason[]> {
  const result = buildProbeResult({ evidence: ingestEvidence(input, validator), checked_at: assessedAt });
  if (result.ok) {
    return result;
  }
  return err(
    result.error.map((reason) =>
      refusal('REEVALUATION_REFUSED', probe.ref.artifact_path, `${reason.code}: ${reason.detail}`),
    ),
  );
}

function reassessmentStatus(
  reevaluation: ProbeReevaluation,
  monitoringComplete: boolean,
): FrozenResultReassessment['status'] {
  if (reevaluation.changes.length > 0) {
    return 'contradictory';
  }
  if (!monitoringComplete) {
    return 'unverified';
  }
  return reevaluation.counted === 0 ? 'none' : 'consistent';
}

function misplacedStream(stream: RawArtifact | undefined): StructuredReason | undefined {
  if (stream === undefined || stream.path === EXECUTION_PATHS.lateEvidenceStream) {
    return undefined;
  }
  const detail = `the late stream is at ${boundedJsonText(stream.path)}; expected ${EXECUTION_PATHS.lateEvidenceStream}`;
  return { code: 'LATE_STREAM_MISPLACED', subject: LATE_EVIDENCE_SUBJECT, detail };
}

// A monitoring that ran but wrote no stream left no evidence of what it observed.
function missingStream(input: ProbeLateEvidenceInput): readonly LateProblem[] {
  if (input.stream !== undefined || input.monitoring.outcome === 'skipped') {
    return [];
  }
  const detail = `monitoring was ${input.monitoring.outcome} but ${EXECUTION_PATHS.lateEvidenceStream} is absent; expected the stream, empty when nothing was observed`;
  return [{ code: 'LATE_STREAM_MISSING', artifact_path: EXECUTION_PATHS.lateEvidenceStream, detail }];
}

function monitoringFields(
  monitoring: EffectiveMonitoring,
  correlated: number,
  reassessments: readonly FrozenResultReassessment[],
): JsonObject {
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

// A correlated record of a probe that froze no result is late evidence without a result to reassess.
function withoutFrozenResult(
  accepted: readonly AcceptedLateRecord[],
  probe: FrozenProbe | undefined,
): readonly StructuredReason[] {
  const [first] = accepted;
  if (probe !== undefined || first === undefined) {
    return [];
  }
  const others = accepted.length > 1 ? ` (and ${String(accepted.length - 1)} more)` : '';
  return [
    {
      code: 'LATE_RECORD_WITHOUT_FROZEN_RESULT',
      subject: LATE_EVIDENCE_SUBJECT,
      artifact_path: EXECUTION_PATHS.lateEvidenceStream,
      detail: `late stream line ${String(first.line_number)} correlates with the probe, which froze no transport probe result; expected a frozen result to reassess${others}`,
    },
  ];
}

// The assessment is checked against its own schema, so input it cannot represent is refused.
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

function refusal(code: string, path: string, detail: string): StructuredReason {
  return { code, subject: LATE_EVIDENCE_SUBJECT, artifact_path: path, detail };
}
