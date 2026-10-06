// Gate G8 `evidence_integrity` (BR-RUA-034; INV-RUA-001; AC-RUA-017 case 3; design §8.3):
// unparseable or schema-invalid required evidence, conflicting events or sequences, a core-file
// digest mismatch and a provider-generated collision are invalid; a re-evaluation without its
// evidence index is unverified; gaps, duplicates and absences are other gates' concern.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assessEvidenceIntegrity } from '../../../src/evidence-ingestion/evidence-integrity-gate.ts';
import type { IngestionInput } from '../../../src/evidence-ingestion/ingestion-model.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { Sha256Hex } from '../../../src/record-contract/primitives.ts';
import type { ScenarioOperation } from '../../support/golden-builder/operation-parsing.ts';
import { artifactBytes, ingest, subjectOf, text, trialInput, withArtifact } from './support/evidence-fixtures.ts';

const CALLER = '$trial/journals/caller-journal.jsonl';
const PROVIDER = '$trial/journals/provider-journal.jsonl';
const NEW_EVENT = '6e6e6e6e-6e6e-4e6e-8e6e-6e6e6e6e6e6e';

function gate(input: IngestionInput): ReturnType<typeof assessEvidenceIntegrity> {
  return assessEvidenceIntegrity(ingest(input));
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
