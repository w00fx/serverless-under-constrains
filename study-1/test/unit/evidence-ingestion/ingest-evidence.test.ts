// The ingestion pipeline (design §8.2, I1-I8) end to end over in-memory evidence, and its totality
// over hostile bytes (Owner amendment A-05): nesting deeper than any call stack, non-finite
// numbers and inherited member names are classified, never thrown on.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { IngestionInput } from '../../../src/evidence-ingestion/ingestion-model.ts';
import { sortFindings } from '../../../src/evidence-ingestion/ingestion-findings.ts';
import type { Sha256Hex } from '../../../src/record-contract/primitives.ts';
import { artifactBytes, ingest, subjectOf, text, trialInput, withArtifact } from './support/evidence-fixtures.ts';

const DEPTH = 100_000;

function hostile(input: IngestionInput, path: string, content: string): IngestionInput {
  return withArtifact(input, path, text(content));
}

describe('ingestEvidence', () => {
  it('ingests a clean run prefix into typed views with no finding', () => {
    const input = trialInput('run-conventional-control');
    const evidence = ingest(input);
    assert.deepEqual(evidence.findings, []);
    assert.equal(evidence.scope.subject_kind, 'trial');
    assert.equal(evidence.expected, input.expected);
    assert.equal(evidence.artifacts.size, input.artifacts.length + input.execution_scope_artifacts.length);
    assert.equal(
      evidence.events.subject.length,
      [...evidence.events.by_id.values()].filter((event) => event.origin === 'subject').length,
    );
    assert.ok(evidence.events.subject.length > 0);
    assert.equal(evidence.events.conflicting_event_ids.size, 0);
    assert.equal(evidence.events.unresolved_causation.size, 0);
    assert.ok([...evidence.events.instances.values()].every((instance) => !instance.gapped));
    assert.equal(evidence.ledger.status, 'present');
    assert.notEqual(evidence.observations.payment, undefined);
    assert.equal(evidence.diagnostics.collapsed_duplicate_count, 0);
    assert.equal(Object.hasOwn(evidence, 'indexed_digests'), false);
  });

  it('reports every required artifact of an empty input as missing, in order', () => {
    const input = trialInput();
    const evidence = ingest({ ...input, artifacts: [], execution_scope_artifacts: [] });
    const required = input.expected.filter((artifact) => artifact.requirement === 'required');
    assert.equal(evidence.findings.length, required.length);
    assert.ok(evidence.findings.every((finding) => finding.code === 'ARTIFACT_MISSING'));
    assert.deepEqual(evidence.findings, sortFindings(evidence.findings));
    assert.equal(evidence.scope.execution, undefined);
    assert.equal(evidence.ledger.status, 'missing');
  });

  it('carries the evidence index of a re-evaluation', () => {
    const input = trialInput();
    const indexed = new Map<string, Sha256Hex>([['runner/runner-journal.jsonl', 'a'.repeat(64) as Sha256Hex]]);
    const evidence = ingest({ ...input, indexed_digests: indexed });
    assert.equal(evidence.indexed_digests, indexed);
    assert.equal(evidence.scope.reevaluation, true);
    assert.deepEqual(
      evidence.findings.map((finding) => finding.code),
      ['CORE_FILE_DIGEST_MISMATCH'],
    );
  });

  it('is deterministic', () => {
    const input = trialInput('run-conventional-treatment');
    const caller = `${subjectOf(input)}/journals/caller-journal.jsonl`;
    const noisy = withArtifact(input, caller, new Uint8Array([...artifactBytes(input, caller), ...text('x\n{}\n')]));
    assert.deepEqual(ingest(noisy).findings, ingest(noisy).findings);
  });
});

describe('ingestEvidence over hostile bytes (A-05)', () => {
  const input = trialInput();
  const caller = `${subjectOf(input)}/journals/caller-journal.jsonl`;
  const payment = `${subjectOf(input)}/inputs/payment.json`;

  it(`classifies ${String(DEPTH)} levels of nesting as schema-invalid, in a line and in a document`, () => {
    const deep = `${'['.repeat(DEPTH)}${']'.repeat(DEPTH)}`;
    const deepObject = `${'{"a":'.repeat(DEPTH)}1${'}'.repeat(DEPTH)}`;
    const evidence = ingest(hostile(hostile(input, caller, `${deep}\n${deepObject}\n`), payment, deepObject));
    assert.deepEqual(
      evidence.artifacts.get(caller)?.records.map((record) => record.validity),
      ['schema_invalid', 'schema_invalid'],
    );
    assert.deepEqual(
      evidence.artifacts.get(payment)?.records.map((record) => record.validity),
      ['schema_invalid'],
    );
    assert.ok(evidence.findings.every((finding) => finding.detail.length <= 220));
  });

  it('reports a non-finite number as unparseable, naming where it is', () => {
    const line = new TextDecoder().decode(artifactBytes(input, caller)).split('\n')[0] ?? '';
    const infinite = line.replace(/"source_sequence":1/u, '"source_sequence":1e400');
    assert.notEqual(infinite, line);
    const evidence = ingest(hostile(hostile(input, caller, `${infinite}\n`), payment, '{"amount":-1e400}'));
    assert.equal(evidence.artifacts.get(caller)?.parse_status, 'unparseable');
    assert.deepEqual(evidence.artifacts.get(caller)?.records, []);
    const details = evidence.findings
      .filter((finding) => finding.code === 'ARTIFACT_UNPARSEABLE')
      .map((finding) => finding.detail);
    assert.deepEqual(details.toSorted(), [
      'expected strict UTF-8 JSON; document: number at JSON pointer "/amount" overflows a finite double',
      'expected strict UTF-8 JSON; line 1: number at JSON pointer "/source_sequence" overflows a finite double',
    ]);
  });

  it('never reads inherited member names as members', () => {
    const lines = [
      '{"__proto__":{"record_type":"dispatch_started"},"constructor":1,"toString":2,"valueOf":3}',
      '{"record_type":"toString","hasOwnProperty":"x"}',
      '{"record_type":"__proto__"}',
    ];
    const evidence = ingest(hostile(input, caller, `${lines.join('\n')}\n`));
    assert.deepEqual(
      evidence.artifacts.get(caller)?.records.map((record) => record.validity),
      ['schema_invalid', 'schema_invalid', 'schema_invalid'],
    );
    assert.equal(
      [...evidence.events.by_id.values()].some((event) => event.artifact_path === caller),
      false,
    );
  });

  it('survives a huge member name and a huge string with bounded details', () => {
    const huge = 'k'.repeat(1_000_000);
    const evidence = ingest(hostile(input, caller, `{"${huge}":"${huge}"}\n`));
    const finding = evidence.findings.find((candidate) => candidate.artifact_path === caller);
    assert.equal(finding?.code, 'RECORD_SCHEMA_INVALID');
    assert.ok(finding.detail.length <= 220);
  });
});
