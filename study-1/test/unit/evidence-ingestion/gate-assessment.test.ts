// Gate assembly (design §8.3): invalid wins over unverified over verified; only the deciding
// causes' reasons and references are carried, merged per code and artifact (A-12), references
// sorted and duplicate-free (BR-RUA-035).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  artifactRef,
  assembleGate,
  eventRef,
  reasonAt,
  recordRef,
} from '../../../src/evidence-ingestion/gate-assessment.ts';
import type { GateCause } from '../../../src/evidence-ingestion/gate-assessment.ts';
import type { EvidenceRef } from '../../../src/record-contract/evidence-refs.ts';
import type { Sha256Hex, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { indexedEvent, uuid, DIGEST } from './support/indexed-events.ts';

const A: EvidenceRef = { artifact_path: 'a.json', artifact_sha256: DIGEST };
const B: EvidenceRef = { artifact_path: 'b.json', artifact_sha256: DIGEST };

function cause(value: GateCause['value'], code: string, ref: EvidenceRef, detail = code): GateCause {
  return { value, reason: reasonAt('BR-RUA-008', code, detail, ref), refs: [ref] };
}

describe('assembleGate', () => {
  it('is verified with the given references when nothing applies', () => {
    assert.deepEqual(assembleGate('traceability', [], [B, A, A]), {
      gate: 'traceability',
      value: 'verified',
      reasons: [],
      evidence_refs: [A, B],
    });
  });

  it('is invalid with only the invalidating causes', () => {
    const gate = assembleGate('evidence_integrity', [cause('unverified', 'U', A), cause('invalid', 'I', B)], [A]);
    assert.equal(gate.value, 'invalid');
    assert.deepEqual(
      gate.reasons.map((reason) => reason.code),
      ['I'],
    );
    assert.deepEqual(gate.evidence_refs, [B]);
  });

  it('is unverified with every unverified cause, references sorted and unique', () => {
    const gate = assembleGate(
      'identity_integrity',
      [cause('unverified', 'Z', B), cause('unverified', 'A', A), cause('unverified', 'A', B)],
      [],
    );
    assert.equal(gate.value, 'unverified');
    assert.deepEqual(
      gate.reasons.map((reason) => [reason.code, reason.artifact_path]),
      [
        ['A', 'a.json'],
        ['A', 'b.json'],
        ['Z', 'b.json'],
      ],
    );
    assert.deepEqual(gate.evidence_refs, [A, B]);
  });

  it('orders reasons without a location by code and detail', () => {
    const unlocated = (code: string, detail: string): GateCause => ({
      value: 'unverified',
      reason: reasonAt('BR-RUA-034', code, detail),
      refs: [],
    });
    const gate = assembleGate('evidence_integrity', [unlocated('B', 'x'), unlocated('A', 'y')], []);
    assert.deepEqual(
      gate.reasons.map((reason) => reason.code),
      ['A', 'B'],
    );
    assert.deepEqual(gate.evidence_refs, []);
  });

  it('merges reasons of one code on one artifact and says how many', () => {
    const gate = assembleGate(
      'traceability',
      [cause('invalid', 'X', A, 'first'), cause('invalid', 'X', A, 'second'), cause('invalid', 'X', A, 'third')],
      [],
    );
    assert.deepEqual(gate.reasons, [
      { code: 'X', subject: 'BR-RUA-008', artifact_path: 'a.json', detail: 'first (and 2 more)' },
    ]);
  });
});

describe('references and reasons', () => {
  it('cites an artifact, a record and an event', () => {
    assert.deepEqual(artifactRef({ path: 'a.json', sha256: DIGEST }), A);
    const artifact = { path: 'a.json', sha256: DIGEST };
    assert.deepEqual(
      recordRef(artifact, { artifact_path: 'a.json', value: { event_id: uuid(1) }, validity: 'valid' }),
      { ...A, event_id: uuid(1) },
    );
    assert.deepEqual(
      recordRef(artifact, { artifact_path: 'a.json', value: { event_id: 'nope' }, validity: 'valid' }),
      A,
    );
    assert.deepEqual(recordRef(artifact, { artifact_path: 'a.json', value: 1, validity: 'valid' }), A);
    const event = indexedEvent({ event_id: uuid(2), artifact_path: 'b.json' });
    assert.deepEqual(eventRef(event), { artifact_path: 'b.json', artifact_sha256: DIGEST, event_id: uuid(2) });
  });

  it('locates a reason at a reference, an artifact or nowhere', () => {
    const ref = { ...A, event_id: uuid(3) as Uuid4, artifact_sha256: 'e'.repeat(64) as Sha256Hex };
    assert.deepEqual(reasonAt('S', 'C', 'd', ref), {
      code: 'C',
      subject: 'S',
      artifact_path: 'a.json',
      event_id: uuid(3),
      detail: 'd',
    });
    assert.deepEqual(reasonAt('S', 'C', 'd', { artifact_path: 'x.json' }), {
      code: 'C',
      subject: 'S',
      artifact_path: 'x.json',
      detail: 'd',
    });
    assert.deepEqual(reasonAt('S', 'C', 'd'), { code: 'C', subject: 'S', detail: 'd' });
  });
});
