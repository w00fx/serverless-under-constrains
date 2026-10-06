// Gate G8 `evidence_integrity` (BR-RUA-034; INV-RUA-001; AC-RUA-017 case 3; design §8.3):
// unparseable or schema-invalid required evidence, conflicting events or sequences, a core-file
// digest mismatch and a provider-generated collision are invalid; a re-evaluation without its
// evidence index is unverified; gaps, duplicates and absences are other gates' concern. Only the
// subject's evidence and the files its evidence index covers decide the gate (review WP-12 R2).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assessEvidenceIntegrity } from '../../../src/evidence-ingestion/evidence-integrity-gate.ts';
import type { IngestionInput } from '../../../src/evidence-ingestion/ingestion-model.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonValue, Sha256Hex } from '../../../src/record-contract/primitives.ts';
import type { ScenarioOperation } from '../../support/golden-builder/operation-parsing.ts';
import {
  artifactBytes,
  artifactValues,
  ingest,
  jsonl,
  subjectOf,
  text,
  trialInput,
  withArtifact,
} from './support/evidence-fixtures.ts';
import { uuid } from './support/indexed-events.ts';

const CALLER = '$trial/journals/caller-journal.jsonl';
const PROVIDER = '$trial/journals/provider-journal.jsonl';
const NEW_EVENT = '6e6e6e6e-6e6e-4e6e-8e6e-6e6e6e6e6e6e';
/** A supplementary journal: the addendum §2 warm-up and A-09 `#provider` partitions land here. */
const READINESS = 'provider/provider-journal.jsonl';
const READINESS_INSTANCE = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';

function gate(input: IngestionInput): ReturnType<typeof assessEvidenceIntegrity> {
  return assessEvidenceIntegrity(ingest(input));
}

/** An execution-level provider event: the runner journal's execution envelope, no trial identity. */
function executionEvent(
  input: IngestionInput,
  sequence: number,
  members: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  const [first] = artifactValues(input, 'runner/runner-journal.jsonl') as [Readonly<Record<string, JsonValue>>];
  return {
    schema_version: 1,
    run_id: first['run_id'] ?? null,
    execution_manifest_sha256: first['execution_manifest_sha256'] ?? null,
    occurred_at: '2026-10-05T12:00:02.000Z',
    source: 'refund_provider',
    event_id: uuid(100 + sequence),
    source_instance_id: READINESS_INSTANCE,
    source_sequence: sequence,
    ...members,
  };
}

function warmup(input: IngestionInput, sequence: number): Readonly<Record<string, JsonValue>> {
  return executionEvent(input, sequence, {
    record_type: 'provider_warmup_completed',
    provider_call_id: uuid(70),
    warmup_id: uuid(70 + sequence),
    received_at: '2026-10-05T12:00:02.000Z',
    completed_at: '2026-10-05T12:00:02.010Z',
    handler_elapsed_ns: '10000000',
  });
}

function verdict(
  operations: readonly ScenarioOperation[],
  base: Parameters<typeof trialInput>[0] = 'run-conventional-control',
): readonly [string, readonly string[]] {
  const result = gate(trialInput(base, operations));
  return [result.value, result.reasons.map((reason) => reason.code)];
}

describe('assessEvidenceIntegrity', () => {
  it('is verified for a clean trial, citing its required and conditional evidence', () => {
    const input = trialInput();
    const result = gate(input);
    assert.equal(result.value, 'verified');
    const cited = result.evidence_refs.map((ref) => ref.artifact_path);
    assert.ok(cited.includes(`${subjectOf(input)}/inputs/payment.json`));
    assert.ok(cited.includes('runner/runner-journal.jsonl'));
    assert.equal(cited.includes(`${subjectOf(input)}/telemetry/telemetry-availability.json`), false);
    assert.equal(cited.includes(`${subjectOf(input)}/state/trial-registration.json`), false);
  });

  it('is invalid on unparseable or schema-invalid required evidence, not on optional evidence', () => {
    const input = trialInput();
    const subject = subjectOf(input);
    assert.equal(gate(withArtifact(input, `${subject}/inputs/payment.json`, text('{'))).value, 'invalid');
    assert.equal(gate(withArtifact(input, `${subject}/inputs/payment.json`, text('{}'))).value, 'invalid');
    assert.equal(
      gate(withArtifact(input, `${subject}/telemetry/telemetry-availability.json`, text('{'))).value,
      'verified',
    );
    assert.equal(gate(withArtifact(input, 'provider/provider-journal.jsonl', text('{'))).value, 'verified');
    assert.equal(gate(withArtifact(input, '/abs.json', text('{}'))).value, 'verified');
  });

  it('is invalid on conflicting content, citing the event', () => {
    const [value, codes] = verdict([
      {
        op: 'clone_record',
        path: CALLER,
        select: { line: 3 },
        set: [{ pointer: '/occurred_at', value: '2026-10-05T12:59:59.999Z' }],
      },
    ]);
    assert.deepEqual([value, codes], ['invalid', ['CONFLICTING_EVENT_CONTENT']]);
    const result = gate(
      trialInput('run-conventional-control', [
        {
          op: 'clone_record',
          path: CALLER,
          select: { line: 3 },
          set: [{ pointer: '/occurred_at', value: '2026-10-05T12:59:59.999Z' }],
        },
      ]),
    );
    assert.notEqual(result.evidence_refs[0]?.event_id, undefined);
  });

  it('is invalid on a conflicting sequence and on a core-file digest mismatch', () => {
    assert.deepEqual(
      verdict([
        { op: 'clone_record', path: CALLER, select: { line: 4 }, set: [{ pointer: '/event_id', value: NEW_EVENT }] },
      ]),
      ['invalid', ['CONFLICTING_SOURCE_SEQUENCE']],
    );
    assert.deepEqual(
      verdict([{ op: 'set', path: '$trial/trial-manifest.json', pointer: '/payment_sha256', value: 'ab'.repeat(32) }]),
      ['invalid', ['CORE_FILE_DIGEST_MISMATCH']],
    );
  });

  it('is invalid on a provider-generated identity collision', () => {
    const [value, codes] = verdict([
      {
        op: 'clone_record',
        path: PROVIDER,
        select: { record_type: 'provider_call_received' },
        set: [{ pointer: '/event_id', value: NEW_EVENT }],
      },
    ]);
    assert.equal(value, 'invalid');
    assert.ok(codes.includes('PROVIDER_IDENTITY_COLLISION'));
  });

  it('is not affected by a gap, a collapsed duplicate or an absent artifact', () => {
    assert.equal(
      verdict([{ op: 'set', path: CALLER, select: { line: 5 }, pointer: '/source_sequence', value: 6 }])[0],
      'verified',
    );
    assert.equal(verdict([{ op: 'clone_record', path: CALLER, select: { line: 2 }, set: [] }])[0], 'verified');
    const input = trialInput();
    assert.equal(
      gate(withArtifact(input, `${subjectOf(input)}/ledger/ledger-snapshot.json`, undefined)).value,
      'verified',
    );
  });

  it('is unverified when a re-evaluation has no evidence index, and verified against a matching one', () => {
    const input = trialInput();
    const missing = gate({ ...input, indexed_digests: new Map() });
    assert.equal(missing.value, 'unverified');
    assert.deepEqual(
      missing.reasons.map((reason) => [reason.code, reason.subject]),
      [['EVIDENCE_INDEX_MISSING', 'BR-RUA-034']],
    );
    assert.deepEqual(missing.evidence_refs, []);
    const caller = `${subjectOf(input)}/journals/caller-journal.jsonl`;
    const indexed = new Map<string, Sha256Hex>([[caller, sha256Hex(artifactBytes(input, caller))]]);
    assert.equal(gate({ ...input, indexed_digests: indexed }).value, 'verified');
  });
});

describe('assessEvidenceIntegrity over supplementary evidence (review WP-12 R2)', () => {
  const input = trialInput();
  const subjectProvider = `${subjectOf(input)}/journals/provider-journal.jsonl`;
  const caller = `${subjectOf(input)}/journals/caller-journal.jsonl`;

  it('does not judge a call id reused only among warm-up records (addendum §2.2)', () => {
    const evidence = ingest(withArtifact(input, READINESS, jsonl([warmup(input, 1), warmup(input, 2)])));
    assert.deepEqual(evidence.findings, []);
    assert.equal(assessEvidenceIntegrity(evidence).value, 'verified');
  });

  it('is invalid when an execution-level rejection reuses a subject call id (A-09, INV-RUA-001)', () => {
    const received = artifactValues(input, subjectProvider).find(
      (value) => (value as Readonly<Record<string, JsonValue>>)['record_type'] === 'provider_call_received',
    ) as Readonly<Record<string, JsonValue>>;
    const rejected = executionEvent(input, 1, {
      record_type: 'provider_call_rejected',
      provider_call_id: received['provider_call_id'] ?? null,
      reason: 'AUTHORIZATION_FAILED',
      detail: 'stray call',
    });
    const result = gate(withArtifact(input, READINESS, jsonl([rejected])));
    assert.equal(result.value, 'invalid');
    assert.deepEqual(
      result.reasons.map((reason) => reason.code),
      ['PROVIDER_IDENTITY_COLLISION'],
    );
  });

  it('reports conflicting copies inside a supplementary file without deciding the gate', () => {
    const event = warmup(input, 1);
    const evidence = ingest(
      withArtifact(input, READINESS, jsonl([event, { ...event, completed_at: '2026-10-05T12:00:02.020Z' }])),
    );
    assert.deepEqual(
      evidence.findings.map((finding) => [finding.code, finding.artifact_path]),
      [['CONFLICTING_EVENT_CONTENT', READINESS]],
    );
    assert.equal(assessEvidenceIntegrity(evidence).value, 'verified');
  });

  it('judges a supplementary file its evidence index covers', () => {
    const event = warmup(input, 1);
    const edited = withArtifact(
      input,
      READINESS,
      jsonl([event, { ...event, completed_at: '2026-10-05T12:00:02.020Z' }]),
    );
    const indexed = new Map<string, Sha256Hex>([[READINESS, sha256Hex(artifactBytes(edited, READINESS))]]);
    const result = gate({ ...edited, indexed_digests: indexed });
    assert.equal(result.value, 'invalid');
    assert.deepEqual(
      result.reasons.map((reason) => [reason.code, reason.artifact_path]),
      [['CONFLICTING_EVENT_CONTENT', READINESS]],
    );
    const mismatched = gate({ ...edited, indexed_digests: new Map([[READINESS, 'ab'.repeat(32) as Sha256Hex]]) });
    assert.equal(mismatched.value, 'invalid');
    assert.ok(mismatched.reasons.some((reason) => reason.code === 'CORE_FILE_DIGEST_MISMATCH'));
  });

  it('keeps the subject copy of an event a supplementary file listed first conflicts with', () => {
    const third = artifactValues(input, caller)[2] as Readonly<Record<string, JsonValue>>;
    const changed = { ...third, occurred_at: '2026-10-05T12:59:59.999Z' };
    const evidence = ingest({
      ...input,
      artifacts: [{ path: READINESS, bytes: jsonl([changed]) }, ...input.artifacts],
    });
    const result = assessEvidenceIntegrity(evidence);
    assert.equal(result.value, 'invalid');
    assert.deepEqual(
      result.reasons.map((reason) => [reason.code, reason.artifact_path]),
      [['CONFLICTING_EVENT_CONTENT', caller]],
    );
    const kept = evidence.events.subject.find((event) => event.record.event_id === third['event_id']);
    assert.equal(kept?.artifact_path, caller);
  });

  it('is invalid when a record lacking correlation carries an own __proto__ member (A-07, review WP-12 R1)', () => {
    const lines = artifactValues(input, caller).map((value) => JSON.stringify(value));
    const { run_id: _dropped, ...uncorrelated } = artifactValues(input, caller)[2] as Readonly<
      Record<string, JsonValue>
    >;
    const tampered = `{"__proto__":{},${JSON.stringify(uncorrelated).slice(1)}`;
    const result = gate(withArtifact(input, caller, text(`${lines.toSpliced(2, 1, tampered).join('\n')}\n`)));
    assert.equal(result.value, 'invalid');
    assert.deepEqual(
      result.reasons.map((reason) => reason.code),
      ['RECORD_SCHEMA_INVALID'],
    );
  });
});
