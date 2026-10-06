// Frozen trials and late records for the late-evidence suites. A frozen trial is a built golden
// base (never read from disk) whose oracle result was evaluated with the real validator and stored
// as its canonical record file, exactly what a trial's `derived/oracle-result.json` holds. Late
// records are derived from the built bytes, so their identities agree with whatever the builder
// assigns: a re-captured ledger with an extra committed transaction (contradicts a CONTROL pass) and
// a duplicate delivery of the treatment's timeout signal (a diagnostic that changes no verdict).

import { canonicalJson, serializeRecordFile } from '../../../../../src/record-contract/canonical-json.ts';
import type { IngestionInput, RawArtifact } from '../../../../../src/evidence-ingestion/ingestion-model.ts';
import type { JsonObject, JsonValue, Result, UtcMillis, Uuid4 } from '../../../../../src/record-contract/primitives.ts';
import type { OracleResult } from '../../../../../src/record-contract/records/group-c/oracle_result.ts';
import type { LateEvidenceSource } from '../../../../../src/record-contract/records/group-c/vocabulary.ts';
import type {
  FrozenTrialEvidence,
  LateEvidenceInput,
  LateMonitoring,
} from '../../../../../src/trial-oracle/late-evidence/late-evidence-input.ts';
import { subjectDirectoryOf } from '../../../../support/golden-builder/scenario-builder.ts';
import { trialIngestionInput } from '../../support/built-trials.ts';
import type { TrialBuild } from '../../support/built-trials.ts';
import { evaluatedTrial } from '../../support/evaluated-trials.ts';
import { subjectRecord } from '../../support/trial-edits.ts';

/** The late stream's package path. */
export const STREAM_PATH = 'late-evidence/late-evidence-stream.jsonl';
/** When the late records were observed and the assessment was made: after every base's freeze. */
export const CAPTURED_AT = '2026-10-05T13:40:00.000Z' as UtcMillis;
export const ASSESSED_AT = '2026-10-05T13:50:00.000Z' as UtcMillis;
/** A complete monitoring of 15 minutes after the final freeze. */
export const COMPLETE_MONITORING: LateMonitoring = {
  outcome: 'complete',
  started_at: '2026-10-05T13:30:00.000Z' as UtcMillis,
  ended_at: '2026-10-05T13:45:00.000Z' as UtcMillis,
};
/** A fresh transaction, commit and call for a late ledger item. */
const LATE_TRANSACTION = {
  provider_transaction_id: 'f6c9bcd7-afde-4b8f-8d6b-5e7acc0fd196',
  provider_commit_id: 'e5b8abc6-9fcd-4a7e-9c5a-4d6fbb9ec085',
  provider_call_id: '3f8a2c61-7d4e-4b19-9c05-e2a6b8d1f374',
} as const;
/** A fresh event id for a late controller event. */
export const LATE_EVENT_ID = '9b2d4f6a-8c1e-4a3b-9d5f-7e0a2c4b6d81';

const encoder = new TextEncoder();
const COMMIT_MEMBERS: ReadonlySet<string> = new Set(['provider_commit_event_id', 'provider_commit_id']);

/** One frozen trial: its frozen evidence, its oracle result and that result's stored bytes. */
export interface FrozenFixture {
  readonly build: TrialBuild;
  readonly frozen: IngestionInput;
  readonly result: OracleResult;
  readonly evidence: FrozenTrialEvidence;
}

const fixtures = new Map<string, FrozenFixture>();

/**
 * A built trial frozen with its evaluated oracle result (cached per build).
 *
 * @example
 * frozenFixture({ base: 'run-conventional-control' }).result.preservation_verdict; // 'pass'
 */
export function frozenFixture(build: TrialBuild): FrozenFixture {
  const key = JSON.stringify(build);
  const cached = fixtures.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const result = evaluatedTrial(build).result;
  const frozen = trialIngestionInput(build);
  const path = `${subjectDirectoryOf(build.base)}/derived/oracle-result.json`;
  const fixture = { build, frozen, result, evidence: { frozen, result: { path, bytes: serializeRecordFile(result) } } };
  fixtures.set(key, fixture);
  return fixture;
}

/** The members of one late record besides its execution and trial identity. */
export interface LateRecordFields {
  readonly sequence: number;
  readonly late_source: LateEvidenceSource;
  readonly late_record: JsonObject;
  /** Defaults to the carried record's own `record_type`. */
  readonly late_record_type?: string;
  /** Defaults to true. */
  readonly correlated?: boolean;
  /** Whether the record names the fixture's trial; defaults to true. */
  readonly trial_scoped?: boolean;
}

/**
 * A late_evidence_record of a fixture's execution, naming its trial unless told otherwise.
 *
 * @example
 * lateRecord(control, { sequence: 1, late_source: 'LEDGER', late_record: lateLedger(control) });
 */
export function lateRecord(fixture: FrozenFixture, fields: LateRecordFields): JsonObject {
  const { result } = fixture;
  const trial =
    fields.trial_scoped === false
      ? {}
      : { trial_id: result.trial_id, trial_manifest_sha256: result.trial_manifest_sha256 };
  return {
    schema_version: 1,
    record_type: 'late_evidence_record',
    run_id: runIdOf(fixture),
    execution_manifest_sha256: result.execution_manifest_sha256,
    ...trial,
    sequence: fields.sequence,
    captured_at: CAPTURED_AT,
    late_source: fields.late_source,
    correlated: fields.correlated ?? true,
    late_record_type: fields.late_record_type ?? textOf(fields.late_record['record_type']),
    late_record: fields.late_record,
  };
}

/**
 * The late stream holding these lines, each canonical JSON terminated by a newline.
 *
 * @example
 * lateStream([lateRecord(control, { ... })]).path; // 'late-evidence/late-evidence-stream.jsonl'
 */
export function lateStream(lines: readonly JsonValue[]): RawArtifact {
  return lateStreamText(lines.map((line) => `${canonicalJson(line)}\n`).join(''));
}

/**
 * The late stream holding exactly this text.
 *
 * @example
 * lateStreamText('{"not":"closed"'); // a truncated stream
 */
export function lateStreamText(text: string): RawArtifact {
  return { path: STREAM_PATH, bytes: encoder.encode(text) };
}

/**
 * The run id of a run trial; throws for a variant-validation trial, which fails the calling test.
 *
 * @example
 * runIdOf(frozenFixture({ base: 'run-conventional-control' })); // the run's UUIDv4
 */
export function runIdOf(fixture: FrozenFixture): Uuid4 {
  const runId = fixture.result.run_id;
  if (runId === undefined) {
    throw new Error(`${fixture.build.base} is not a run; expected a run trial`);
  }
  return runId;
}

function textOf(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

/**
 * The assessment input of these frozen trials with a complete monitoring, unless overridden.
 *
 * @example
 * assessLateEvidence(lateInput([control], lateStream([])), validator);
 */
export function lateInput(
  trials: readonly FrozenFixture[],
  stream: RawArtifact | undefined,
  monitoring: LateMonitoring = COMPLETE_MONITORING,
): LateEvidenceInput {
  const [first] = trials;
  if (first === undefined) {
    throw new Error('lateInput got no frozen trial; expected at least one to take the execution from');
  }
  return {
    execution: { run_id: runIdOf(first) },
    execution_manifest_sha256: first.result.execution_manifest_sha256,
    monitoring,
    ...(stream === undefined ? {} : { stream }),
    trials: trials.map((trial) => trial.evidence),
    assessed_at: ASSESSED_AT,
  };
}

/**
 * The fixture's ledger snapshot re-captured after freeze, with `extra` more committed transactions
 * of the same attempt (at most one).
 *
 * @example
 * lateLedger(control, 1)['transactions']; // the frozen transaction plus a late one
 */
export function lateLedger(fixture: FrozenFixture, extra: 0 | 1): JsonObject {
  const ledger = subjectRecord(fixture.build, '$trial/ledger/ledger-snapshot.json', 'ledger_snapshot');
  const transactions = ledger['transactions'] as readonly JsonObject[];
  const [first] = transactions;
  const added = extra === 1 && first !== undefined ? [{ ...first, ...LATE_TRANSACTION }] : [];
  return { ...ledger, captured_at: CAPTURED_AT, transactions: [...transactions, ...added] };
}

/**
 * A duplicate delivery of the treatment's recorded timeout signal, observed by the controller
 * after freeze: the next event of the controller's instance.
 *
 * @example
 * duplicateSignal(treatment)['record_type']; // 'timeout_signal_duplicate_observed'
 */
export function duplicateSignal(fixture: FrozenFixture): JsonObject {
  const recorded = subjectRecord(fixture.build, '$trial/journals/controller-journal.jsonl', 'timeout_signal_recorded');
  // The duplicate names the signalled caller event, not the commit the signal resolved.
  const envelope = Object.fromEntries(Object.entries(recorded).filter(([member]) => !COMMIT_MEMBERS.has(member)));
  return {
    ...envelope,
    record_type: 'timeout_signal_duplicate_observed',
    event_id: LATE_EVENT_ID,
    source_sequence: Number(recorded['source_sequence']) + 1,
    occurred_at: CAPTURED_AT,
    causation_event_ids: [textOf(recorded['event_id'])],
    treatment_state: 'TIMEOUT_SIGNALLED',
  };
}

/**
 * The reasons of a refused result; throws on a success, which fails the calling test.
 *
 * @example
 * refusalOf(monitoringWindow({ outcome: 'shortened', ended_at })).code; // 'MONITORING_WINDOW_INVALID'
 */
export function refusalOf<T, E>(result: Result<T, E>): E {
  if (result.ok) {
    throw new Error('got a success; expected a refusal');
  }
  return result.error;
}

/**
 * The first item of a list; throws on an empty list, which fails the calling test.
 *
 * @example
 * firstOf(reading.problems).code;
 */
export function firstOf<T>(items: readonly T[]): T {
  const [first] = items;
  if (first === undefined) {
    throw new Error('got an empty list; expected at least one item');
  }
  return first;
}
