// Reading a transport probe's late stream (BR-RUA-043; design §8.13): a correlated record of this
// probe with a place in its frozen evidence is accepted with its route; an uncorrelated record is
// kept out without a problem; every other line is a late problem naming the line, the offending
// value and the expected shape. The route follows the source: the probe journals, the probe ledger,
// the shared runner journal, and the execution provider journal for a causal-root rejection (A-09).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readProbeLateStream, routeProbeLateRecord } from '../../../src/execution-lifecycle/probe-late-stream.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import type { LateEvidenceRecord } from '../../../src/record-contract/records/group-c/late_evidence_record.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { conventionalInvocationStarted } from '../../contract/record-contract/group-b/examples/caller-examples.ts';
import {
  controllerCanaryAcknowledged,
  timeoutSignalRecorded,
} from '../../contract/record-contract/group-b/examples/controller-examples.ts';
import { ledgerSnapshot } from '../../contract/record-contract/group-b/examples/observation-examples.ts';
import {
  providerCallReceived,
  providerCallRejected,
} from '../../contract/record-contract/group-b/examples/provider-examples.ts';
import { probeWorkloadInvoked } from '../../contract/record-contract/group-b/examples/runner-examples.ts';
import { RUN_ID, digest, toJson } from '../../support/record-contract/record-builders.ts';
import {
  PROBE_CONTEXT,
  probeLateLine,
  probeScoped,
  probeStream,
  probeStreamText,
} from './support/probe-late-records.ts';

const validator = createRecordValidator();
const received = probeScoped(providerCallReceived());
const receivedLine = (sequence: number, overrides: JsonObject = {}): JsonObject => ({
  ...probeLateLine({ sequence, late_source: 'PROVIDER_JOURNAL', late_record: received }),
  ...overrides,
});

function codesOf(lines: readonly JsonObject[]): readonly string[] {
  return readProbeLateStream(probeStream(lines), PROBE_CONTEXT, validator).problems.map((problem) => problem.code);
}

function detailOf(lines: readonly JsonObject[]): string {
  return readProbeLateStream(probeStream(lines), PROBE_CONTEXT, validator).problems[0]?.detail ?? '';
}

function routed(line: JsonObject): ReturnType<typeof routeProbeLateRecord> {
  return routeProbeLateRecord(line as unknown as LateEvidenceRecord);
}

describe('readProbeLateStream', () => {
  it('reads nothing from an absent or empty stream', () => {
    assert.deepEqual(readProbeLateStream(undefined, PROBE_CONTEXT, validator), { accepted: [], problems: [] });
    assert.deepEqual(readProbeLateStream(probeStream([]), PROBE_CONTEXT, validator), { accepted: [], problems: [] });
  });

  it('accepts a correlated probe record with its route and line', () => {
    const reading = readProbeLateStream(probeStream([receivedLine(1)]), PROBE_CONTEXT, validator);
    assert.deepEqual(reading.problems, []);
    assert.equal(reading.accepted.length, 1);
    assert.equal(reading.accepted[0]?.line_number, 1);
    assert.deepEqual(reading.accepted[0].route, {
      path: 'probe/journals/provider-journal.jsonl',
      fold: 'append_line',
      shared: false,
    });
  });

  it('keeps an uncorrelated record out without a problem', () => {
    const uncorrelated = probeLateLine({
      sequence: 1,
      late_source: 'CONTROLLER_JOURNAL',
      late_record: probeScoped(controllerCanaryAcknowledged()),
      correlated: false,
    });
    assert.deepEqual(readProbeLateStream(probeStream([uncorrelated]), PROBE_CONTEXT, validator), {
      accepted: [],
      problems: [],
    });
  });

  it('names a stream whose last line is not terminated', () => {
    const text = JSON.stringify(receivedLine(1));
    const reading = readProbeLateStream(probeStreamText(text), PROBE_CONTEXT, validator);
    assert.deepEqual(
      reading.problems.map((problem) => problem.code),
      ['LATE_STREAM_TRUNCATED'],
    );
    assert.match(reading.problems[0]?.detail ?? '', /the last line \(1\) has no terminating newline/);
    assert.equal(reading.accepted.length, 1, 'the complete record is still read');
  });

  it('names a line that is not JSON, and one that is not UTF-8', () => {
    const notJson = readProbeLateStream(probeStreamText('{"a":\n'), PROBE_CONTEXT, validator);
    assert.deepEqual(
      notJson.problems.map((problem) => [problem.code, problem.artifact_path]),
      [['LATE_RECORD_UNREADABLE', EXECUTION_PATHS.lateEvidenceStream]],
    );
    assert.match(notJson.problems[0]?.detail ?? '', /^line 1: .*; expected one UTF-8 JSON object$/);
    const bytes = new Uint8Array([0x7b, 0xff, 0x7d, 0x0a]);
    const notUtf8 = readProbeLateStream({ path: EXECUTION_PATHS.lateEvidenceStream, bytes }, PROBE_CONTEXT, validator);
    assert.match(notUtf8.problems[0]?.detail ?? '', /^line 1: "invalid UTF-8 at byte 1"/);
  });

  it('names a line that is not a late evidence record', () => {
    assert.deepEqual(codesOf([{ record_type: 'late_evidence_record' }]), ['LATE_RECORD_SCHEMA_INVALID']);
    assert.match(detailOf([{ record_type: 'late_evidence_record' }]), /; expected a late_evidence_record$/);
  });

  it('names a sequence that is not dense from 1', () => {
    assert.deepEqual(codesOf([receivedLine(2)]), ['LATE_SEQUENCE_BROKEN']);
    assert.equal(detailOf([receivedLine(2)]), 'line 1: sequence 2; expected 1 (dense from 1)');
  });

  it('names a record or a carried record of another execution, manifest or of a trial', () => {
    const otherProbe = receivedLine(1, { transport_probe_id: RUN_ID });
    assert.deepEqual(codesOf([otherProbe]), ['LATE_RECORD_FOREIGN']);
    assert.match(detailOf([otherProbe]), /^line 1: the record names another execution; expected transport_probe_id/);
    const runRecord = receivedLine(1, { late_record: { ...received, run_id: RUN_ID } });
    assert.match(detailOf([runRecord]), /^line 1: late_record names another execution/);
    const otherManifest = receivedLine(1, {
      late_record: { ...received, execution_manifest_sha256: digest('other') },
    });
    assert.match(
      detailOf([otherManifest]),
      /late_record names execution manifest "[0-9a-f]{64}"; expected [0-9a-f]{64}$/,
    );
    const trialRecord = receivedLine(1, { late_record: { ...received, trial_id: RUN_ID } });
    assert.match(
      detailOf([trialRecord]),
      /late_record names trial ".*"; expected a probe record, which names no trial$/,
    );
  });

  it('names a carried record whose type is not the declared one', () => {
    const mismatched = receivedLine(1, { late_record_type: 'provider_call_accepted' });
    assert.deepEqual(codesOf([mismatched]), ['LATE_RECORD_TYPE_MISMATCH']);
    assert.match(
      detailOf([mismatched]),
      /late_record.record_type is "provider_call_received"; expected late_record_type "provider_call_accepted"$/,
    );
    const untyped = receivedLine(1, { late_record: { ...received, record_type: 7 } });
    assert.match(detailOf([untyped]), /late_record.record_type is null; expected/);
  });

  it('names a record that has no place in the probe evidence', () => {
    const fromDlq = probeLateLine({ sequence: 1, late_source: 'DLQ', late_record: received });
    assert.deepEqual(codesOf([fromDlq]), ['LATE_RECORD_UNROUTABLE']);
    assert.match(detailOf([fromDlq]), /"provider_call_received" from DLQ has no place in the probe's frozen evidence/);
  });

  it('names a carried record that is not valid, as unverifiable rather than contradictory', () => {
    const corrupt = receivedLine(1, { late_record: { ...received, provider_call_id: 7 } });
    assert.deepEqual(codesOf([corrupt]), ['LATE_RECORD_SCHEMA_INVALID']);
    assert.match(detailOf([corrupt]), /^line 1: late_record .*; expected a valid provider_call_received$/);
  });
});

describe('routeProbeLateRecord', () => {
  it('folds a re-captured ledger snapshot into the probe ledger, and nothing else from the ledger', () => {
    const snapshot = probeLateLine({ sequence: 1, late_source: 'LEDGER', late_record: probeScoped(ledgerSnapshot()) });
    assert.deepEqual(routed(snapshot), {
      path: 'probe/ledger/ledger-snapshot.json',
      fold: 'ledger_transactions',
      shared: false,
    });
    assert.equal(routed(probeLateLine({ sequence: 1, late_source: 'LEDGER', late_record: received })), undefined);
  });

  it('appends caller, controller and runner events to their journals', () => {
    const caller = probeLateLine({
      sequence: 1,
      late_source: 'CALLER_JOURNAL',
      late_record: probeScoped(conventionalInvocationStarted()),
    });
    assert.deepEqual(routed(caller), {
      path: 'probe/journals/caller-journal.jsonl',
      fold: 'append_line',
      shared: false,
    });
    const controller = probeLateLine({
      sequence: 1,
      late_source: 'CONTROLLER_JOURNAL',
      late_record: probeScoped(timeoutSignalRecorded()),
    });
    assert.deepEqual(routed(controller), {
      path: 'probe/journals/controller-journal.jsonl',
      fold: 'append_line',
      shared: false,
    });
    const runner = probeLateLine({
      sequence: 1,
      late_source: 'RUNNER_JOURNAL',
      late_record: toJson(probeWorkloadInvoked()),
    });
    assert.deepEqual(routed(runner), { path: EXECUTION_PATHS.runnerJournal, fold: 'append_line', shared: true });
  });

  it('places a causal-root rejection in the execution provider journal, an attributed one in the probe journal', () => {
    const rejected = probeScoped(providerCallRejected());
    const { causation_event_ids: _causes, ...root } = rejected;
    const rootLine = probeLateLine({ sequence: 1, late_source: 'PROVIDER_JOURNAL', late_record: root });
    assert.deepEqual(routed(rootLine), {
      path: EXECUTION_PATHS.executionProviderJournal,
      fold: 'append_line',
      shared: true,
    });
    const attributed = probeLateLine({
      sequence: 1,
      late_source: 'PROVIDER_JOURNAL',
      late_record: { ...rejected, causation_event_ids: [digest('cause').slice(0, 36)] },
    });
    assert.equal(routed(attributed)?.path, 'probe/journals/provider-journal.jsonl');
  });

  it('has no place for a type that is not an event record', () => {
    const notEvent = probeLateLine({
      sequence: 1,
      late_source: 'PROVIDER_JOURNAL',
      late_record: { record_type: 'ledger_snapshot' },
    });
    assert.equal(routed(notEvent), undefined);
    const unknown = probeLateLine({
      sequence: 1,
      late_source: 'PROVIDER_JOURNAL',
      late_record: { record_type: 'no_such_record' },
    });
    assert.equal(routed(unknown), undefined);
  });
});
