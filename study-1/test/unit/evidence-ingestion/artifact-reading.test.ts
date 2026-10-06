// Design §8.2 step I1 (BR-RUA-033, BR-RUA-035, BR-RUA-037): strict UTF-8 JSON or JSONL per
// artifact, normalized paths, one byte sequence per path, every required artifact present.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { missingArtifactFinding, readArtifacts } from '../../../src/evidence-ingestion/artifact-reading.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import { artifactBytes, subjectOf, text, trialInput, withArtifact } from './support/evidence-fixtures.ts';

const input = trialInput();
const subject = subjectOf(input);
const CALLER = `${subject}/journals/caller-journal.jsonl`;

describe('readArtifacts', () => {
  it('parses every artifact of a clean trial and tells subject, supplementary and scope apart', () => {
    const reading = readArtifacts(input);
    assert.deepEqual(reading.findings, []);
    const byPath = new Map(reading.artifacts.map((artifact) => [artifact.path, artifact]));
    const caller = byPath.get(CALLER);
    assert.equal(caller?.origin, 'subject');
    assert.equal(caller.artifact_class, 'caller_journal');
    assert.equal(caller.requirement, 'required');
    assert.equal(caller.parse_status, 'parsed');
    assert.equal(caller.sha256, sha256Hex(artifactBytes(input, CALLER)));
    assert.equal(caller.byte_length, artifactBytes(input, CALLER).length);
    assert.deepEqual(
      caller.values.map((value) => value.line_number),
      [1, 2, 3, 4, 5],
    );
    const registration = byPath.get(`${subject}/state/trial-registration.json`);
    assert.equal(registration?.origin, 'supplementary');
    assert.equal(registration.artifact_class, undefined);
    assert.equal(registration.values[0]?.line_number, undefined);
    assert.equal(reading.artifacts.length, input.artifacts.length);
  });

  it('marks a JSONL file with bad lines unparseable, keeps its good lines and aggregates one finding', () => {
    const bytes = new Uint8Array([...artifactBytes(input, CALLER), ...text('{"torn":\nnot json\n')]);
    const reading = readArtifacts(withArtifact(input, CALLER, bytes));
    const caller = reading.artifacts.find((artifact) => artifact.path === CALLER);
    assert.equal(caller?.parse_status, 'unparseable');
    assert.equal(caller.values.length, 5);
    assert.equal(reading.findings.length, 1);
    const [finding] = reading.findings;
    assert.equal(finding?.code, 'ARTIFACT_UNPARSEABLE');
    assert.equal(finding.artifact_path, CALLER);
    assert.equal(finding.occurrences, 2);
    assert.match(finding.detail, /^expected strict UTF-8 JSON; line 6: .* \(and 1 more\)$/u);
  });

  it('reports ill-formed UTF-8 with its byte offset and keeps no value of a broken document', () => {
    const path = `${subject}/inputs/payment.json`;
    const reading = readArtifacts(withArtifact(input, path, Uint8Array.of(0x7b, 0xc0, 0x80, 0x7d)));
    const payment = reading.artifacts.find((artifact) => artifact.path === path);
    assert.equal(payment?.parse_status, 'unparseable');
    assert.deepEqual(payment.values, []);
    assert.equal(reading.findings[0]?.detail, 'expected strict UTF-8 JSON; document: invalid UTF-8 at byte 1');
  });

  it('reports invalid JSON in a document', () => {
    const path = `${subject}/inputs/payment.json`;
    const reading = readArtifacts(withArtifact(input, path, text('{')));
    assert.match(reading.findings[0]?.detail ?? '', /^expected strict UTF-8 JSON; document: /u);
  });

  it('drops an artifact whose path is not normalized, reporting it without a path', () => {
    for (const path of ['/abs.json', 'a/../b.json', '', 'a//b.json']) {
      const reading = readArtifacts(withArtifact(input, path, text('{}')));
      assert.equal(
        reading.artifacts.some((artifact) => artifact.path === path),
        false,
      );
      assert.equal(reading.findings.length, 1, path);
      assert.equal(reading.findings[0]?.code, 'ARTIFACT_UNPARSEABLE');
      assert.equal(reading.findings[0].artifact_path, undefined);
      assert.match(reading.findings[0].detail, /expected a normalized package-relative POSIX path$/u);
    }
  });

  it('collapses a path given twice with the same bytes', () => {
    const repeated = {
      ...input,
      artifacts: [...input.artifacts, { path: CALLER, bytes: artifactBytes(input, CALLER) }],
    };
    assert.deepEqual(readArtifacts(repeated).findings, []);
  });

  it('keeps the first of a path given twice with different bytes and reports the second', () => {
    const repeated = { ...input, artifacts: [...input.artifacts, { path: CALLER, bytes: text('') }] };
    const reading = readArtifacts(repeated);
    assert.equal(reading.findings.length, 1);
    assert.equal(reading.findings[0]?.artifact_path, CALLER);
    assert.equal(reading.artifacts.find((artifact) => artifact.path === CALLER)?.values.length, 5);
  });

  it('reports a missing required artifact and nothing for a missing optional one', () => {
    const telemetry = `${subject}/telemetry/telemetry-availability.json`;
    const ledger = `${subject}/ledger/ledger-snapshot.json`;
    const reading = readArtifacts(withArtifact(withArtifact(input, telemetry, undefined), ledger, undefined));
    assert.deepEqual(
      reading.findings.map((finding) => [finding.code, finding.artifact_path]),
      [['ARTIFACT_MISSING', ledger]],
    );
  });

  it('gives execution-scope artifacts the execution_scope origin even at an expected path', () => {
    const scopeInput = { ...input, artifacts: [], execution_scope_artifacts: [{ path: CALLER, bytes: text('') }] };
    const reading = readArtifacts(scopeInput);
    assert.equal(reading.artifacts[0]?.origin, 'execution_scope');
    assert.equal(reading.artifacts[0].artifact_class, 'caller_journal');
    assert.ok(reading.findings.every((finding) => finding.code === 'ARTIFACT_MISSING'));
  });
});

describe('missingArtifactFinding', () => {
  it('names the path, class and requirement', () => {
    const finding = missingArtifactFinding({
      path: 'trials/t/dlq/dlq-snapshot.json',
      artifact_class: 'dlq_snapshot',
      requirement: 'required',
    });
    assert.equal(finding.code, 'ARTIFACT_MISSING');
    assert.equal(finding.artifact_path, 'trials/t/dlq/dlq-snapshot.json');
    assert.equal(
      finding.detail,
      'trials/t/dlq/dlq-snapshot.json (dlq_snapshot) is absent; expected the required artifact to be present',
    );
  });
});
