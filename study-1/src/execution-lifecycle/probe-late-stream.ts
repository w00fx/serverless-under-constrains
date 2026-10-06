// Reading a transport probe's `late-evidence/late-evidence-stream.jsonl` (BR-RUA-043; catalogue
// group C row 77; design §8.13). The trial oracle's reader accepts only runs and validations (its
// lines must belong to a frozen trial), so the probe has its own, with the same rules: every line is
// one late record, dense from sequence 1; a correlated record that is valid, belongs to this probe
// (and to no trial: the probe has none, D-06), carries a valid record of its own type and has a
// place in the probe's frozen evidence is accepted; an uncorrelated record (canary and warm-up
// readiness evidence, addendum §2) correlates with nothing. Any other line is a late problem.
//
// Probe lines carry no unit field, so a record's place follows from its source (late-record
// capture re-reads the probe partition `<execution_id>#probe` and the A-09 provider partition):
// caller, provider and controller events join `probe/journals/`, a re-captured ledger snapshot
// folds into `probe/ledger/ledger-snapshot.json`, and runner events join the runner journal. The
// A-09 `<execution_id>#provider` partition holds only causal-root `provider_call_rejected` records;
// the attributable rejection in the probe partition is caused by its received event, so a
// rejection without causation belongs to `provider/provider-journal.jsonl`. The bytes are
// untrusted: reading is total and quotes untrusted values bounded (A-05).

import { namesOtherExecution, ownString } from '../evidence-ingestion/record-correlation.ts';
import type { RawArtifact } from '../evidence-ingestion/ingestion-model.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import { boundedJsonText, isJsonObject } from '../record-contract/json-value.ts';
import { parseJsonl } from '../record-contract/parsing.ts';
import type { JsonlLine } from '../record-contract/parsing.ts';
import type { JsonValue, Sha256Hex, Uuid4 } from '../record-contract/primitives.ts';
import { isEventRecordType, isRecordType } from '../record-contract/record-types.ts';
import type { LateEvidenceRecord } from '../record-contract/records/group-c/late_evidence_record.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { describeFirstViolation } from '../trial-oracle/late-evidence/late-evidence-reasons.ts';
import type { LateProblem, LateProblemCode } from '../trial-oracle/late-evidence/late-evidence-reasons.ts';
import type { LateRoute } from '../trial-oracle/late-evidence/late-record-routing.ts';
import type { AcceptedLateRecord, LateStreamReading } from '../trial-oracle/late-evidence/late-stream-reading.ts';

/** The probe every stream line must belong to. */
export interface ProbeStreamContext {
  readonly transport_probe_id: Uuid4;
  readonly execution_manifest_sha256: Sha256Hex;
}

type LineVerdict =
  | { readonly kind: 'accepted'; readonly record: AcceptedLateRecord }
  | { readonly kind: 'uncorrelated' }
  | { readonly kind: 'problem'; readonly code: LateProblemCode; readonly detail: string };

const PROBE = { kind: 'probe' } as const;

/** The probe journal each event source appends to. */
const PROBE_JOURNALS: Readonly<Partial<Record<LateEvidenceRecord['late_source'], string>>> = {
  CALLER_JOURNAL: PACKAGE_LAYOUT.unitFile(PROBE, 'callerJournal'),
  PROVIDER_JOURNAL: PACKAGE_LAYOUT.unitFile(PROBE, 'providerJournal'),
  CONTROLLER_JOURNAL: PACKAGE_LAYOUT.unitFile(PROBE, 'controllerJournal'),
  RUNNER_JOURNAL: EXECUTION_PATHS.runnerJournal,
};

/**
 * Reads the late stream of one probe. An absent stream reads as no line; whether its absence is a
 * problem depends on how monitoring ended, which the caller knows.
 *
 * @example
 * const reading = readProbeLateStream(stream, { transport_probe_id, execution_manifest_sha256 }, validator);
 * reading.accepted.length; // the correlated records to fold into the probe's frozen evidence
 */
export function readProbeLateStream(
  stream: RawArtifact | undefined,
  context: ProbeStreamContext,
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

/**
 * Where a correlated probe late record joins the probe's frozen evidence, or undefined when its
 * source and record type have no place there.
 *
 * @example
 * routeProbeLateRecord(lateCommitConfirmed); // { path: 'probe/journals/provider-journal.jsonl', fold: 'append_line', shared: false }
 */
export function routeProbeLateRecord(record: LateEvidenceRecord): LateRoute | undefined {
  const type = record.late_record_type;
  if (record.late_source === 'LEDGER') {
    return type === 'ledger_snapshot'
      ? { path: PACKAGE_LAYOUT.unitFile(PROBE, 'ledgerSnapshot'), fold: 'ledger_transactions', shared: false }
      : undefined;
  }
  const journal = PROBE_JOURNALS[record.late_source];
  if (journal === undefined || !isRecordType(type) || !isEventRecordType(type)) {
    return undefined;
  }
  if (record.late_source === 'PROVIDER_JOURNAL' && isUnattributedRejection(record.late_record)) {
    return { path: EXECUTION_PATHS.executionProviderJournal, fold: 'append_line', shared: true };
  }
  return { path: journal, fold: 'append_line', shared: journal === EXECUTION_PATHS.runnerJournal };
}

// A-09: the execution-level partition holds only causal roots of `provider_call_rejected`.
function isUnattributedRejection(carried: JsonValue): boolean {
  return (
    ownString(carried, 'record_type') === 'provider_call_rejected' &&
    !(isJsonObject(carried) && Object.hasOwn(carried, 'causation_event_ids'))
  );
}

function readLine(line: JsonlLine, context: ProbeStreamContext, validator: RecordValidator): LineVerdict {
  const at = `line ${String(line.line_number)}`;
  if (!line.parsed.ok) {
    const failure = line.parsed.error;
    const why =
      failure.kind === 'invalid_utf8' ? `invalid UTF-8 at byte ${String(failure.byte_offset)}` : failure.detail;
    return problem('LATE_RECORD_UNREADABLE', `${at}: ${boundedJsonText(why)}; expected one UTF-8 JSON object`);
  }
  const validation = validator.validateAs('late_evidence_record', line.parsed.value);
  if (!validation.valid) {
    const why = describeFirstViolation(validation.violations);
    return problem('LATE_RECORD_SCHEMA_INVALID', `${at}: ${why}; expected a late_evidence_record`);
  }
  const record = validation.record as LateEvidenceRecord;
  if (record.sequence !== line.line_number) {
    const detail = `${at}: sequence ${String(record.sequence)}; expected ${String(line.line_number)} (dense from 1)`;
    return problem('LATE_SEQUENCE_BROKEN', detail);
  }
  return record.correlated
    ? readCorrelated(record, line.parsed.value, line.line_number, context, validator)
    : { kind: 'uncorrelated' };
}

function readCorrelated(
  record: LateEvidenceRecord,
  raw: JsonValue,
  lineNumber: number,
  context: ProbeStreamContext,
  validator: RecordValidator,
): LineVerdict {
  const at = `line ${String(lineNumber)}`;
  const foreign = foreignMember(raw, record.late_record, context);
  if (foreign !== undefined) {
    return problem('LATE_RECORD_FOREIGN', `${at}: ${foreign}`);
  }
  const carriedType = ownString(record.late_record, 'record_type');
  if (carriedType !== record.late_record_type) {
    const detail = `${at}: late_record.record_type is ${boundedJsonText(carriedType ?? null)}; expected late_record_type ${boundedJsonText(record.late_record_type)}`;
    return problem('LATE_RECORD_TYPE_MISMATCH', detail);
  }
  const route = routeProbeLateRecord(record);
  if (route === undefined) {
    const detail = `${at}: ${boundedJsonText(record.late_record_type)} from ${record.late_source} has no place in the probe's frozen evidence; expected a journal event or re-captured ledger snapshot of the probe`;
    return problem('LATE_RECORD_UNROUTABLE', detail);
  }
  // A corrupt carried record is unverifiable late evidence, never a contradiction (as for trials).
  const carried = validator.validate(record.late_record);
  if (!carried.valid) {
    const detail = `${at}: late_record ${describeFirstViolation(carried.violations)}; expected a valid ${record.late_record_type}`;
    return problem('LATE_RECORD_SCHEMA_INVALID', detail);
  }
  return { kind: 'accepted', record: { record, route, line_number: lineNumber } };
}

// The record and the record it carries must both belong to this probe and name no trial.
function foreignMember(raw: JsonValue, carried: JsonValue, context: ProbeStreamContext): string | undefined {
  const active = { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: context.transport_probe_id } as const;
  for (const [name, value] of [
    ['the record', raw],
    ['late_record', carried],
  ] as const) {
    if (namesOtherExecution(value, active)) {
      return `${name} names another execution; expected transport_probe_id ${context.transport_probe_id}`;
    }
    const digest = ownString(value, 'execution_manifest_sha256');
    if (digest !== undefined && digest !== context.execution_manifest_sha256) {
      return `${name} names execution manifest ${boundedJsonText(digest)}; expected ${context.execution_manifest_sha256}`;
    }
    const trial = ownString(value, 'trial_id');
    if (trial !== undefined) {
      return `${name} names trial ${boundedJsonText(trial)}; expected a probe record, which names no trial`;
    }
  }
  return undefined;
}

function problem(code: LateProblemCode, detail: string): LineVerdict {
  return { kind: 'problem', code, detail };
}
