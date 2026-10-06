// Reading `late-evidence/late-evidence-stream.jsonl` (BR-RUA-043, catalogue group C row 77): every
// line is one late record, dense from sequence 1, of this execution. A correlated record that is
// valid, belongs to this execution and has a place in the frozen evidence is accepted for
// reassessment; an uncorrelated record is kept in the stream but correlates with nothing, so it is
// neither counted nor folded. Any line that cannot be read this way is a late problem: late
// monitoring then yielded no verifiable late evidence. The bytes are untrusted, so reading is total
// and quotes untrusted values bounded (Owner amendment A-05).

import { namesOtherExecution, ownString } from '../../evidence-ingestion/record-correlation.ts';
import type { RawArtifact } from '../../evidence-ingestion/ingestion-model.ts';
import { boundedJsonText } from '../../record-contract/json-value.ts';
import { parseJsonl } from '../../record-contract/parsing.ts';
import type { JsonlLine } from '../../record-contract/parsing.ts';
import type { ExecutionIdentity, JsonValue, Sha256Hex } from '../../record-contract/primitives.ts';
import type { RecordValidator } from '../../record-contract/schema-registry.ts';
import type { LateEvidenceRecord } from '../../record-contract/records/group-c/late_evidence_record.ts';
import type { TrialExecutionIdentity } from '../../record-contract/records/group-c/shared-shapes.ts';
import type { LateProblem, LateProblemCode } from './late-evidence-reasons.ts';
import { routeLateRecord } from './late-record-routing.ts';
import type { LateRoute } from './late-record-routing.ts';

/** What a stream line must belong to: the execution and its frozen trials. */
export interface LateStreamContext {
  readonly execution: TrialExecutionIdentity;
  readonly execution_manifest_sha256: Sha256Hex;
  /** Each frozen trial's id with the digest of its trial manifest. */
  readonly trial_manifests: ReadonlyMap<string, Sha256Hex>;
}

/** A correlated late record accepted for reassessment, with its place in the frozen evidence. */
export interface AcceptedLateRecord {
  readonly record: LateEvidenceRecord;
  readonly route: LateRoute;
  readonly line_number: number;
}

export interface LateStreamReading {
  readonly accepted: readonly AcceptedLateRecord[];
  readonly problems: readonly LateProblem[];
}

type LineVerdict =
  | { readonly kind: 'accepted'; readonly record: AcceptedLateRecord }
  | { readonly kind: 'uncorrelated' }
  | { readonly kind: 'problem'; readonly code: LateProblemCode; readonly detail: string };

/**
 * Reads the late stream of one execution. An absent stream reads as no line; whether its absence
 * is a problem depends on how monitoring ended, which the caller knows.
 *
 * @example
 * const reading = readLateStream(stream, { execution: { run_id }, execution_manifest_sha256, trial_manifests }, validator);
 * reading.accepted.length; // the correlated records to fold into the frozen evidence
 */
export function readLateStream(
  stream: RawArtifact | undefined,
  context: LateStreamContext,
  validator: RecordValidator,
): LateStreamReading {
  if (stream === undefined) {
    return { accepted: [], problems: [] };
  }
  const report = parseJsonl(stream.bytes);
  const accepted: AcceptedLateRecord[] = [];
  const problems: LateProblem[] = [];
  if (report.lines.length > 0 && !report.ends_with_newline) {
    const detail = `the last line (${String(report.lines.length)}) has no terminating newline; expected every JSONL line to end with \\n`;
    problems.push({ code: 'LATE_STREAM_TRUNCATED', artifact_path: stream.path, detail });
  }
  for (const line of report.lines) {
    const verdict = readLine(line, context, validator);
    if (verdict.kind === 'accepted') {
      accepted.push(verdict.record);
    }
    if (verdict.kind === 'problem') {
      problems.push({ code: verdict.code, artifact_path: stream.path, detail: verdict.detail });
    }
  }
  return { accepted, problems };
}

function readLine(line: JsonlLine, context: LateStreamContext, validator: RecordValidator): LineVerdict {
  const at = `line ${String(line.line_number)}`;
  if (!line.parsed.ok) {
    const failure = line.parsed.error;
    const why =
      failure.kind === 'invalid_utf8' ? `invalid UTF-8 at byte ${String(failure.byte_offset)}` : failure.detail;
    return problem('LATE_RECORD_UNREADABLE', `${at}: ${boundedJsonText(why)}; expected one UTF-8 JSON object`);
  }
  const validation = validator.validateAs('late_evidence_record', line.parsed.value);
  if (!validation.valid) {
    const why = validation.violations
      .slice(0, 1)
      .map((violation) => `${violation.instance_path} ${violation.detail}`)
      .join('');
    return problem('LATE_RECORD_SCHEMA_INVALID', `${at}: ${boundedJsonText(why)}; expected a late_evidence_record`);
  }
  const record = validation.record as LateEvidenceRecord;
  if (record.sequence !== line.line_number) {
    const detail = `${at}: sequence ${String(record.sequence)}; expected ${String(line.line_number)} (dense from 1)`;
    return problem('LATE_SEQUENCE_BROKEN', detail);
  }
  return record.correlated
    ? readCorrelated(record, line.parsed.value, line.line_number, context)
    : { kind: 'uncorrelated' };
}

function readCorrelated(
  record: LateEvidenceRecord,
  raw: JsonValue,
  lineNumber: number,
  context: LateStreamContext,
): LineVerdict {
  const at = `line ${String(lineNumber)}`;
  const foreign = foreignMember(record, raw, context);
  if (foreign !== undefined) {
    return problem('LATE_RECORD_FOREIGN', `${at}: ${foreign}`);
  }
  const carriedType = ownString(record.late_record, 'record_type');
  if (carriedType !== record.late_record_type) {
    const detail = `${at}: late_record.record_type is ${boundedJsonText(carriedType ?? null)}; expected late_record_type ${boundedJsonText(record.late_record_type)}`;
    return problem('LATE_RECORD_TYPE_MISMATCH', detail);
  }
  const manifestProblem = trialManifestProblem(record, context);
  if (manifestProblem !== undefined) {
    return problem('LATE_TRIAL_MANIFEST_MISMATCH', `${at}: ${manifestProblem}`);
  }
  const route = routeLateRecord(record);
  if (route === undefined) {
    const scope = record.trial_id === undefined ? 'execution-level' : 'trial';
    const detail = `${at}: ${scope} ${boundedJsonText(record.late_record_type)} from ${record.late_source} has no place in the frozen evidence; expected a journal event, queue observation or re-captured snapshot of its source`;
    return problem('LATE_RECORD_UNROUTABLE', detail);
  }
  return { kind: 'accepted', record: { record, route, line_number: lineNumber } };
}

// The record and the record it carries must both belong to this execution, and the carried
// record to the same trial when both name one.
function foreignMember(record: LateEvidenceRecord, raw: JsonValue, context: LateStreamContext): string | undefined {
  const active = activeExecution(context.execution);
  const carried: JsonValue = record.late_record;
  for (const [name, value] of [
    ['the record', raw],
    ['late_record', carried],
  ] as const) {
    if (namesOtherExecution(value, active)) {
      return `${name} names another execution; expected ${describeExecution(context.execution)}`;
    }
    const digest = ownString(value, 'execution_manifest_sha256');
    if (digest !== undefined && digest !== context.execution_manifest_sha256) {
      return `${name} names execution manifest ${boundedJsonText(digest)}; expected ${context.execution_manifest_sha256}`;
    }
  }
  const carriedTrial = ownString(carried, 'trial_id');
  if (record.trial_id !== undefined && carriedTrial !== undefined && carriedTrial !== record.trial_id) {
    return `late_record names trial ${boundedJsonText(carriedTrial)}; expected the record's trial ${record.trial_id}`;
  }
  return undefined;
}

function trialManifestProblem(record: LateEvidenceRecord, context: LateStreamContext): string | undefined {
  const trialId = record.trial_id;
  const frozenDigest = trialId === undefined ? undefined : context.trial_manifests.get(trialId);
  if (frozenDigest === undefined || frozenDigest === record.trial_manifest_sha256) {
    return undefined;
  }
  return `trial ${String(trialId)} names trial manifest ${String(record.trial_manifest_sha256)}; expected the frozen ${frozenDigest}`;
}

function problem(code: LateProblemCode, detail: string): LineVerdict {
  return { kind: 'problem', code, detail };
}

/**
 * The execution identity a trial execution's id names.
 *
 * @example
 * activeExecution({ run_id }); // { execution_kind: 'RUN', run_id }
 */
export function activeExecution(execution: TrialExecutionIdentity): ExecutionIdentity {
  return execution.run_id === undefined
    ? { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: execution.variant_validation_id }
    : { execution_kind: 'RUN', run_id: execution.run_id };
}

function describeExecution(execution: TrialExecutionIdentity): string {
  return execution.run_id === undefined
    ? `variant_validation_id ${execution.variant_validation_id}`
    : `run_id ${execution.run_id}`;
}
