// Gate G3 `identity_integrity` (INV-RUA-001; AC-RUA-017; design §8.3): proven caller-generated
// reuse is invalid; an unregistered attempt reference, an absent, unparseable or gapped caller
// journal, or an unreadable earlier trial is unverified.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assessEvidenceIntegrity } from '../../../src/evidence-ingestion/evidence-integrity-gate.ts';
import { assessIdentityIntegrity } from '../../../src/evidence-ingestion/identity-integrity-gate.ts';
import type {
  IdentityCollision,
  IdentityRegistry,
  IngestionInput,
} from '../../../src/evidence-ingestion/ingestion-model.ts';
import type { EvidenceRef } from '../../../src/record-contract/evidence-refs.ts';
import type { Sha256Hex } from '../../../src/record-contract/primitives.ts';
import type { ScenarioOperation } from '../../support/golden-builder/operation-parsing.ts';
import {
  artifactBytes,
  ingest,
  probeInput,
  subjectOf,
  text,
  trialInput,
  withArtifact,
} from './support/evidence-fixtures.ts';
import { uuid } from './support/indexed-events.ts';

const CALLER = '$trial/journals/caller-journal.jsonl';

function gate(input: IngestionInput): ReturnType<typeof assessIdentityIntegrity> {
  return assessIdentityIntegrity(ingest(input));
}

function codes(input: IngestionInput): readonly string[] {
  return gate(input).reasons.map((reason) => reason.code);
}

describe('assessIdentityIntegrity', () => {
  it('is verified for clean trials and the probe, citing the caller journal', () => {
    const input = trialInput('run-conventional-treatment');
    const result = gate(input);
    assert.equal(result.value, 'verified');
    assert.deepEqual(
      result.evidence_refs.map((ref) => ref.artifact_path),
      [`${subjectOf(input)}/journals/caller-journal.jsonl`],
    );
    assert.equal(gate(probeInput()).value, 'verified');
  });

  it('is invalid on a caller-generated identity registered twice', () => {
    const operations: readonly ScenarioOperation[] = [
      {
        op: 'clone_record',
        path: CALLER,
        select: { record_type: 'attempt_registered' },
        set: [{ pointer: '/event_id', value: '6e6e6e6e-6e6e-4e6e-8e6e-6e6e6e6e6e6e' }],
      },
    ];
    const result = gate(trialInput('run-conventional-control', operations));
    assert.equal(result.value, 'invalid');
    assert.deepEqual(
      result.reasons.map((reason) => reason.code),
      ['CALLER_IDENTITY_REUSED'],
    );
    assert.match(
      result.reasons[0]?.detail ?? '',
      /^expected (attempt_id|provider_request_id) .* to be unique in the execution scope; created by 2 events across partitions /u,
    );
    assert.equal(result.reasons[0]?.subject, 'INV-RUA-001');
    assert.ok(result.evidence_refs.some((ref) => ref.event_id === '6e6e6e6e-6e6e-4e6e-8e6e-6e6e6e6e6e6e'));
  });

  it('is unverified when a subject record references an unregistered attempt', () => {
    const operations: readonly ScenarioOperation[] = [
      { op: 'remove_record', path: CALLER, select: { record_type: 'attempt_registered' } },
    ];
    const result = gate(trialInput('run-conventional-control', operations));
    assert.equal(result.value, 'unverified');
    assert.ok(result.reasons.some((reason) => reason.code === 'ATTEMPT_UNREGISTERED'));
    assert.match(
      result.reasons.find((reason) => reason.code === 'ATTEMPT_UNREGISTERED')?.detail ?? '',
      /to have an attempt_registered event; none was read/u,
    );
  });

  it('is unverified when the caller journal is absent, citing nothing for it', () => {
    const input = trialInput();
    const caller = `${subjectOf(input)}/journals/caller-journal.jsonl`;
    const result = gate(withArtifact(input, caller, undefined));
    assert.equal(result.value, 'unverified');
    const missing = result.reasons.find((reason) => reason.code === 'ARTIFACT_MISSING');
    assert.equal(missing?.artifact_path, caller);
    assert.ok(result.evidence_refs.every((ref) => ref.artifact_path !== caller));
  });

  it('is unverified when the caller journal is unparseable or gapped', () => {
    const input = trialInput();
    const caller = `${subjectOf(input)}/journals/caller-journal.jsonl`;
    const torn = withArtifact(input, caller, new Uint8Array([...artifactBytes(input, caller), ...text('{')]));
    assert.deepEqual(codes(torn), ['ARTIFACT_UNPARSEABLE']);
    const gapped = trialInput('run-conventional-control', [
      { op: 'set', path: CALLER, select: { line: 5 }, pointer: '/source_sequence', value: 6 },
    ]);
    assert.deepEqual(codes(gapped), ['SOURCE_SEQUENCE_GAP']);
    assert.equal(gate(gapped).value, 'unverified');
  });

  it('is unverified when an earlier trial cannot be read', () => {
    const input = trialInput('run-conventional-treatment');
    const scope = input.execution_scope_artifacts.map((artifact) =>
      artifact.path.endsWith('caller-journal.jsonl') ? { ...artifact, bytes: text('{"torn"\n') } : artifact,
    );
    const invalid = input.execution_scope_artifacts.map((artifact) =>
      artifact.path.endsWith('caller-journal.jsonl')
        ? { ...artifact, bytes: text('{"record_type":"nothing"}\n') }
        : artifact,
    );
    for (const execution_scope_artifacts of [scope, invalid]) {
      const result = gate({ ...input, execution_scope_artifacts });
      assert.equal(result.value, 'unverified');
      assert.deepEqual(
        result.reasons.map((reason) => reason.code),
        ['IDENTITY_SCOPE_INCOMPLETE', 'IDENTITY_SCOPE_INCOMPLETE'],
      );
    }
  });

  it('does not ask for a caller journal the expected set does not name', () => {
    const input = trialInput();
    const expected = input.expected.filter((artifact) => artifact.artifact_class !== 'caller_journal');
    const caller = `${subjectOf(input)}/journals/caller-journal.jsonl`;
    const result = gate({ ...withArtifact(input, caller, undefined), expected });
    assert.equal(
      result.reasons.some((reason) => reason.code === 'ARTIFACT_MISSING'),
      false,
    );
  });
});

describe('identity reasons are bounded (A-12, review WP-12 R3)', () => {
  it('quotes a collision over many partitions, and a long identity, in bounded text for G3 and G8', () => {
    const evidence = ingest(trialInput());
    const ref: EvidenceRef = {
      artifact_path: 'runner/runner-journal.jsonl',
      artifact_sha256: 'c'.repeat(64) as Sha256Hex,
    };
    const collision = (kind: IdentityCollision['kind']): IdentityCollision => ({
      kind,
      id: 'x'.repeat(10_000),
      origin_event_ids: [uuid(1), uuid(2)],
      partitions: Array.from({ length: 1_000 }, (_, index) => uuid(index + 1)),
      refs: [ref],
    });
    const identities: IdentityRegistry = {
      caller_collisions: [collision('attempt_id')],
      provider_collisions: [collision('provider_call_id')],
      unregistered_attempts: [{ attempt_id: 'y'.repeat(10_000), ref }],
    };
    const g3 = assessIdentityIntegrity({ ...evidence, identities });
    const g8 = assessEvidenceIntegrity({ ...evidence, identities });
    assert.equal(g3.value, 'invalid');
    assert.equal(g8.value, 'invalid');
    const details = [...g3.reasons, ...g8.reasons].map((reason) => reason.detail);
    assert.equal(details.length, 2);
    for (const detail of details) {
      assert.ok(detail.length < 600, `detail of ${String(detail.length)} characters`);
      assert.match(detail, /…\[truncated\]/u);
    }
    const unregistered = assessIdentityIntegrity({ ...evidence, identities: { ...identities, caller_collisions: [] } });
    assert.ok((unregistered.reasons[0]?.detail.length ?? 0) < 600);
  });
});
