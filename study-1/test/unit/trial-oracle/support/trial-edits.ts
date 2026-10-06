// Scenario operations the oracle suites derive from a built trial: a record of the subject trial
// read back from the built bytes, and a runner event appended to the shared runner journal with the
// subject's envelope and the next runner sequence. Deriving the values from the build keeps each
// test's edit valid for whatever identities the builder assigns.

import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';
import { fixtureRecords } from '../../../golden/_harness/golden-harness.ts';
import type { ScenarioOperation } from '../../../support/golden-builder/operation-parsing.ts';
import { subjectDirectoryOf } from '../../../support/golden-builder/scenario-builder.ts';
import { builtFiles } from './built-trials.ts';
import type { TrialBuild } from './built-trials.ts';

const RUNNER_JOURNAL = 'runner/runner-journal.jsonl';
/** The envelope members an appended runner event copies from the subject's `settlement_assessed`. */
const ENVELOPE_MEMBERS = [
  'schema_version',
  'run_id',
  'variant_validation_id',
  'execution_manifest_sha256',
  'trial_id',
  'trial_manifest_sha256',
  'occurred_at',
  'source',
  'source_instance_id',
] as const;
/** A fresh UUIDv4 for an appended runner event. */
export const APPENDED_EVENT_ID = '0f3c6b9e-2a5d-4e81-9b47-6d8a1c3e5f02';

/**
 * The records of one file of a build; `$trial/` names the subject trial's directory.
 *
 * @example
 * builtRecords({ base: 'run-conventional-control' }, '$trial/journals/caller-journal.jsonl').length;
 */
export function builtRecords(build: TrialBuild, path: string): readonly JsonObject[] {
  const resolved = path.startsWith('$trial/')
    ? `${subjectDirectoryOf(build.base)}/${path.slice('$trial/'.length)}`
    : path;
  return fixtureRecords(builtFiles(build), resolved);
}

/**
 * The subject trial's last record of one type in a file of a build; throws when there is none.
 *
 * @example
 * subjectRecord({ base: 'run-conventional-control' }, RUNNER_JOURNAL, 'settlement_assessed').event_id;
 */
export function subjectRecord(build: TrialBuild, path: string, recordType: string): JsonObject {
  const trialDirectory = subjectDirectoryOf(build.base);
  const found = builtRecords(build, path)
    .filter((record) => record['record_type'] === recordType)
    .filter((record) => path.startsWith('$trial/') || `trials/${optionalText(record['trial_id'])}` === trialDirectory)
    .at(-1);
  if (found === undefined) {
    throw new Error(`${path} of ${build.base} has no ${recordType} for the subject trial; expected one`);
  }
  return found;
}

/**
 * A string member of a record; throws when the member is absent or not a string.
 *
 * @example
 * textMember(subjectRecord(build, RUNNER_JOURNAL, 'settlement_assessed'), 'event_id'); // '6d0f...'
 */
export function textMember(record: JsonObject, member: string): string {
  const value = record[member];
  if (typeof value !== 'string') {
    const shown = value === undefined ? 'absent' : JSON.stringify(value);
    throw new Error(`member ${member} is ${shown}; expected a string`);
  }
  return value;
}

function optionalText(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Appends a runner event of the subject trial: its envelope copies the subject's
 * `settlement_assessed`, its sequence follows the journal's last one.
 *
 * @example
 * appendRunnerEvent(build, { record_type: 'trial_interrupted', cause: 'LEASE_LOST', detail: 'lost' });
 */
export function appendRunnerEvent(build: TrialBuild, members: Readonly<Record<string, JsonValue>>): ScenarioOperation {
  const template = subjectRecord(build, RUNNER_JOURNAL, 'settlement_assessed');
  const sequences = builtRecords(build, RUNNER_JOURNAL).map((record) => Number(record['source_sequence']));
  const envelope = ENVELOPE_MEMBERS.flatMap((member) => {
    const value = template[member];
    return value === undefined ? [] : [[member, value] as const];
  });
  const record: JsonObject = {
    ...Object.fromEntries(envelope),
    event_id: APPENDED_EVENT_ID,
    source_sequence: Math.max(...sequences) + 1,
    ...members,
  };
  return { op: 'insert_record', path: RUNNER_JOURNAL, record };
}

/** The subject trial's caller journal. */
export const CALLER_JOURNAL = '$trial/journals/caller-journal.jsonl';

/**
 * Rewrites the caller's nth `dispatch_started` into the conditional `attempt_not_dispatched`
 * transition: the attempt never crossed the dispatch boundary (BR-RUA-021).
 *
 * @example
 * edited(CONVENTIONAL_CONTROL, notDispatched(1));
 */
export function notDispatched(occurrence: number): readonly ScenarioOperation[] {
  const select = { record_type: 'dispatch_started', occurrence };
  const failure = { code: 'CALL_BUILD_FAILED', subject: 'BR-RUA-021', detail: 'the provider call could not be built' };
  return [
    { op: 'set', path: CALLER_JOURNAL, select, pointer: '/failure', value: failure },
    { op: 'remove', path: CALLER_JOURNAL, select, pointer: '/deadline_at' },
    { op: 'remove', path: CALLER_JOURNAL, select, pointer: '/deadline_ns' },
    { op: 'remove', path: CALLER_JOURNAL, select, pointer: '/dispatch_at' },
    // Last: the selector names the record by its type until here.
    { op: 'set', path: CALLER_JOURNAL, select, pointer: '/record_type', value: 'attempt_not_dispatched' },
  ];
}

/**
 * Removes the caller's nth attempt outcome and keeps the journal dense.
 *
 * @example
 * edited(CONVENTIONAL_CONTROL, withoutOutcome(1));
 */
export function withoutOutcome(occurrence: number): readonly ScenarioOperation[] {
  return [
    { op: 'remove_record', path: CALLER_JOURNAL, select: { record_type: 'attempt_outcome_recorded', occurrence } },
    { op: 'resequence', path: CALLER_JOURNAL },
  ];
}

/**
 * Leaves only the caller's invocation records: no attempt was ever registered, and the journal
 * stays dense and complete.
 *
 * @example
 * edited(CONVENTIONAL_CONTROL, withoutAttempts());
 */
export function withoutAttempts(): readonly ScenarioOperation[] {
  const types = ['attempt_registered', 'dispatch_started', 'attempt_outcome_recorded', 'request_state_recorded'];
  return [
    ...types.map((recordType): ScenarioOperation => ({
      op: 'remove_record',
      path: CALLER_JOURNAL,
      select: { record_type: recordType },
    })),
    { op: 'resequence', path: CALLER_JOURNAL },
  ];
}
