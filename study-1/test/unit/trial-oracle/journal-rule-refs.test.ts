// The caller journal reference the journal rules add when the journal is gapped (BR-RUA-035).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EvidenceRef } from '../../../src/record-contract/evidence-refs.ts';
import { withCaller } from '../../../src/trial-oracle/journal-rule-refs.ts';

const ref = (path: string): EvidenceRef => ({ artifact_path: path, artifact_sha256: 'b'.repeat(64) }) as EvidenceRef;

describe('withCaller', () => {
  it('returns the references unchanged when the journal was never given', () => {
    const refs = [ref('trials/t/inputs/payment.json')];
    assert.equal(withCaller(refs, undefined), refs);
  });

  it('adds the journal in canonical order when it was given', () => {
    const caller = ref('trials/t/journals/caller-journal.jsonl');
    const payment = ref('trials/t/inputs/payment.json');
    const ledger = ref('trials/t/ledger/ledger-snapshot.json');
    assert.deepEqual(withCaller([ledger, payment], caller), [payment, caller, ledger]);
  });

  it('never repeats a journal the references already cite', () => {
    const caller = ref('trials/t/journals/caller-journal.jsonl');
    assert.deepEqual(withCaller([caller], caller), [caller]);
  });
});
