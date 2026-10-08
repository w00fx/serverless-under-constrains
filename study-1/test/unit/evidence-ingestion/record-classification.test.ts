// Design §8.2 step I2 (BR-RUA-033, BR-RUA-008, AC-RUA-041 case 1): every record is validated
// against the type its artifact demands; a record whose only faults are absent correlation
// members, or a trial-directory record without a trial identity, is CORRELATION_MISSING; any
// other fault is RECORD_SCHEMA_INVALID. Findings are aggregated per artifact (A-12).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readArtifacts } from '../../../src/evidence-ingestion/artifact-reading.ts';
import type {
  IngestedArtifact,
  IngestionFinding,
  IngestionInput,
} from '../../../src/evidence-ingestion/ingestion-model.ts';
import { classifyRecords } from '../../../src/evidence-ingestion/record-classification.ts';
import { resolveScope } from '../../../src/evidence-ingestion/scope-resolution.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import type { ScenarioOperation } from '../../support/golden-builder/operation-parsing.ts';
import {
  VALIDATOR,
  artifactValues,
  jsonl,
  probeInput,
  subjectOf,
  text,
  trialInput,
  withArtifact,
} from './support/evidence-fixtures.ts';

const CALLER = '$trial/journals/caller-journal.jsonl';
const RUNNER = 'runner/runner-journal.jsonl';

interface Classified {
  readonly artifacts: ReadonlyMap<string, IngestedArtifact>;
  readonly findings: readonly IngestionFinding[];
}

function classify(input: IngestionInput): Classified {
  const reading = readArtifacts(input);
  const scope = resolveScope(reading.artifacts, input.expected, false, VALIDATOR);
  const classified = classifyRecords(reading.artifacts, scope, VALIDATOR);
  return {
    artifacts: new Map(classified.artifacts.map((artifact) => [artifact.path, artifact])),
    findings: classified.findings,
  };
}

function validities(classified: Classified, path: string): readonly string[] {
  return classified.artifacts.get(path)?.records.map((record) => record.validity) ?? [];
}

function removing(pointer: string, recordType: string, path = CALLER): readonly ScenarioOperation[] {
  return [{ op: 'remove', path, select: { record_type: recordType }, pointer }];
}

describe('classifyRecords', () => {
  it('finds every record of a clean trial valid', () => {
    const classified = classify(trialInput());
    assert.deepEqual(classified.findings, []);
    for (const artifact of classified.artifacts.values()) {
      assert.ok(
        artifact.records.every((record) => record.validity === 'valid'),
        artifact.path,
      );
    }
  });

  it('classifies an event without its execution identity as correlation-missing', () => {
    const input = trialInput('run-conventional-control', removing('/run_id', 'dispatch_started'));
    const caller = `${subjectOf(input)}/journals/caller-journal.jsonl`;
    const classified = classify(input);
    assert.deepEqual(validities(classified, caller), ['valid', 'valid', 'correlation_missing', 'valid', 'valid']);
    assert.equal(classified.findings.length, 1);
    const [finding] = classified.findings;
    assert.equal(finding?.code, 'CORRELATION_MISSING');
    assert.equal(finding.artifact_path, caller);
    assert.equal(finding.detail, 'expected execution and trial correlation members; line 3: run_id absent');
  });

  it('classifies absent manifest digests and a lone trial member as correlation-missing', () => {
    for (const [pointer, recordType] of [
      ['/execution_manifest_sha256', 'attempt_registered'],
      ['/trial_manifest_sha256', 'attempt_registered'],
    ] as const) {
      const input = trialInput('run-conventional-control', removing(pointer, recordType));
      const caller = `${subjectOf(input)}/journals/caller-journal.jsonl`;
      assert.equal(validities(classify(input), caller)[1], 'correlation_missing', pointer);
    }
  });

  it('classifies a published message without its trial digest as correlation-missing', () => {
    const operations: readonly ScenarioOperation[] = [
      { op: 'remove', path: '$trial/inputs/published-message.json', pointer: '/trial_manifest_sha256' },
    ];
    const input = trialInput('run-conventional-control', operations);
    const path = `${subjectOf(input)}/inputs/published-message.json`;
    assert.deepEqual(validities(classify(input), path), ['correlation_missing']);
  });

  it('classifies a trial-directory event without the trial pair as correlation-missing, though the schema allows it', () => {
    const operations: readonly ScenarioOperation[] = [
      ...removing('/trial_id', 'dispatch_started'),
      ...removing('/trial_manifest_sha256', 'dispatch_started'),
    ];
    const input = trialInput('run-conventional-control', operations);
    const classified = classify(input);
    assert.equal(validities(classified, `${subjectOf(input)}/journals/caller-journal.jsonl`)[2], 'correlation_missing');
    assert.match(classified.findings[0]?.detail ?? '', /trial_id absent$/u);
  });

  it('keeps an execution-level event without a trial pair valid', () => {
    const classified = classify(trialInput());
    assert.ok(validities(classified, RUNNER).every((validity) => validity === 'valid'));
  });

  it('keeps the payment and approved decision, which carry no correlation, valid', () => {
    const input = trialInput();
    const classified = classify(input);
    assert.deepEqual(validities(classified, `${subjectOf(input)}/inputs/payment.json`), ['valid']);
    assert.deepEqual(validities(classified, `${subjectOf(input)}/inputs/approved-decision.json`), ['valid']);
  });

  it('keeps a probe record without a trial identity valid', () => {
    const classified = classify(probeInput());
    assert.deepEqual(classified.findings, []);
  });

  it('classifies any other fault as schema-invalid, quoting at most three violations per artifact', () => {
    const operations: readonly ScenarioOperation[] = [
      { op: 'set', path: CALLER, select: { line: 2 }, pointer: '/amount_minor', value: -1 },
      { op: 'set', path: CALLER, select: { line: 3 }, pointer: '/source', value: 'nobody' },
    ];
    const input = trialInput('run-conventional-control', operations);
    const caller = `${subjectOf(input)}/journals/caller-journal.jsonl`;
    const classified = classify(input);
    assert.deepEqual(validities(classified, caller), ['valid', 'schema_invalid', 'schema_invalid', 'valid', 'valid']);
    const [finding] = classified.findings;
    assert.equal(finding?.code, 'RECORD_SCHEMA_INVALID');
    assert.equal(finding.occurrences, 2);
    assert.match(finding.detail, /^expected a valid journal event record; line 2: \/amount_minor /u);
    assert.match(finding.detail, /\(and 1 more\)$/u);
  });

  it('classifies a record missing correlation and also malformed as schema-invalid', () => {
    const operations: readonly ScenarioOperation[] = [
      ...removing('/run_id', 'dispatch_started'),
      { op: 'set', path: CALLER, select: { record_type: 'dispatch_started' }, pointer: '/dispatch_at', value: 'noon' },
    ];
    const input = trialInput('run-conventional-control', operations);
    assert.equal(validities(classify(input), `${subjectOf(input)}/journals/caller-journal.jsonl`)[2], 'schema_invalid');
  });

  it('classifies a record missing correlation that carries an own inherited-name member as schema-invalid', () => {
    // Review finding WP-12 R1: filling the absent members through `Object.assign` ran the
    // `__proto__` setter, so the member vanished and the record passed as correlation-missing.
    const input = trialInput();
    const caller = `${subjectOf(input)}/journals/caller-journal.jsonl`;
    const lines = artifactValues(input, caller).map((value) => JSON.stringify(value));
    const { run_id: _dropped, ...uncorrelated } = artifactValues(input, caller)[2] as Readonly<
      Record<string, JsonValue>
    >;
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const tampered = `{${JSON.stringify(name)}:{},${JSON.stringify(uncorrelated).slice(1)}`;
      const bytes = text(`${lines.toSpliced(2, 1, tampered).join('\n')}\n`);
      const classified = classify(withArtifact(input, caller, bytes));
      assert.deepEqual(validities(classified, caller), ['valid', 'valid', 'schema_invalid', 'valid', 'valid'], name);
      assert.deepEqual(
        classified.findings.map((finding) => finding.code),
        ['RECORD_SCHEMA_INVALID'],
        name,
      );
    }
  });

  it('rejects a non-event record in a journal and a record of the wrong type in a document', () => {
    const input = trialInput();
    const subject = subjectOf(input);
    const [payment] = artifactValues(input, `${subject}/inputs/payment.json`) as [JsonValue];
    const caller = `${subject}/journals/caller-journal.jsonl`;
    const edited = withArtifact(
      withArtifact(input, caller, jsonl([...artifactValues(input, caller), payment])),
      `${subject}/inputs/approved-decision.json`,
      text(JSON.stringify(payment)),
    );
    const classified = classify(edited);
    assert.equal(validities(classified, caller)[5], 'schema_invalid');
    assert.deepEqual(validities(classified, `${subject}/inputs/approved-decision.json`), ['schema_invalid']);
    const callerFinding = classified.findings.find((finding) => finding.artifact_path === caller);
    assert.match(
      callerFinding?.detail ?? '',
      /^expected a valid journal event record; line 6: \/record_type record_type: record_type "payment" is not a journal event/u,
    );
    const decisionFinding = classified.findings.find((finding) => finding.artifact_path !== caller);
    assert.match(
      decisionFinding?.detail ?? '',
      /^expected a valid approved_decision record; document: \/record_type const:/u,
    );
  });

  it('classifies a JSON value that is not an object as schema-invalid', () => {
    const input = trialInput();
    const caller = `${subjectOf(input)}/journals/caller-journal.jsonl`;
    const classified = classify(withArtifact(input, caller, jsonl([5, null, []])));
    assert.deepEqual(validities(classified, caller), ['schema_invalid', 'schema_invalid', 'schema_invalid']);
    assert.match(classified.findings[0]?.detail ?? '', /line 1: \/ type: /u);
  });

  it('validates a supplementary artifact against the type it declares', () => {
    const input = trialInput();
    const path = 'provider/provider-journal.jsonl';
    const [event] = artifactValues(input, RUNNER) as [JsonValue];
    const classified = classify(withArtifact(input, path, jsonl([event, { record_type: 'nothing' }])));
    assert.deepEqual(validities(classified, path), ['valid', 'schema_invalid']);
    assert.equal(classified.artifacts.get(path)?.origin, 'supplementary');
  });

  it('fills the run identity when the execution manifest is unusable', () => {
    const input = withArtifact(
      trialInput('run-conventional-control', removing('/run_id', 'dispatch_started')),
      'admission/execution-manifest.json',
      text('{'),
    );
    const caller = `${subjectOf(input)}/journals/caller-journal.jsonl`;
    assert.equal(validities(classify(input), caller)[2], 'correlation_missing');
  });

  it('fills the scope kind of execution identity for a variant validation', () => {
    const operations = removing('/variant_validation_id', 'dispatch_started');
    const input = trialInput('validation-durable-control', operations);
    const caller = `${subjectOf(input)}/journals/caller-journal.jsonl`;
    assert.ok(validities(classify(input), caller).includes('correlation_missing'));
  });

  it('keeps the line number of each record and none for a document', () => {
    const input = trialInput();
    const classified = classify(input);
    const caller = classified.artifacts.get(`${subjectOf(input)}/journals/caller-journal.jsonl`);
    assert.deepEqual(
      caller?.records.map((record) => record.line_number),
      [1, 2, 3, 4, 5],
    );
    const payment = classified.artifacts.get(`${subjectOf(input)}/inputs/payment.json`);
    assert.equal(payment?.requirement, 'required');
    assert.equal(payment.records[0]?.line_number, undefined);
    assert.equal(classified.artifacts.get(RUNNER)?.artifact_class, 'runner_journal');
  });
});
