// Gate G5 `ledger_access` (BR-RUA-034): a complete, consistent snapshot without duplicate ids.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GateAssessment } from '../../../src/evidence-ingestion/ingestion-model.ts';
import { assessLedgerAccess } from '../../../src/trial-oracle/ledger-access-gate.ts';
import { builtEvidence } from './support/built-trials.ts';
import type { TrialBuild } from './support/built-trials.ts';
import { CONVENTIONAL_CONTROL, CONVENTIONAL_TREATMENT, edited } from './support/trial-plans.ts';

const LEDGER = '$trial/ledger/ledger-snapshot.json';
const assess = (build: TrialBuild): GateAssessment<'ledger_access'> => assessLedgerAccess(builtEvidence(build));
const codes = (gate: ReturnType<typeof assess>): readonly string[] => gate.reasons.map((reason) => reason.code);

describe('assessLedgerAccess', () => {
  it('verifies a complete consistent snapshot, citing it', () => {
    const gate = assess(CONVENTIONAL_TREATMENT);
    assert.equal(gate.gate, 'ledger_access');
    assert.equal(gate.value, 'verified');
    assert.equal(gate.evidence_refs.length, 1);
  });

  it('leaves an absent snapshot unverified with ARTIFACT_MISSING', () => {
    const gate = assess(edited(CONVENTIONAL_CONTROL, [{ op: 'delete_file', path: LEDGER }]));
    assert.equal(gate.value, 'unverified');
    assert.deepEqual(codes(gate), ['ARTIFACT_MISSING']);
    assert.deepEqual(gate.evidence_refs, []);
  });

  it('leaves incomplete pagination unverified (AC-RUA-007 case 1)', () => {
    const gate = assess(
      edited(CONVENTIONAL_CONTROL, [{ op: 'set', path: LEDGER, pointer: '/pages/0/next_cursor', value: 'page-2' }]),
    );
    assert.equal(gate.value, 'unverified');
    assert.deepEqual(codes(gate), ['LEDGER_PAGINATION_INCOMPLETE']);
    assert.match(gate.reasons[0]?.detail ?? '', /pagination is incomplete \(.+\); expected every page read/);
  });

  it('reports incomplete pagination and an inconsistent read together', () => {
    const gate = assess(
      edited(CONVENTIONAL_CONTROL, [
        { op: 'set', path: LEDGER, pointer: '/pages/0/next_cursor', value: 'page-2' },
        { op: 'set', path: LEDGER, pointer: '/consistent_read', value: false },
      ]),
    );
    assert.equal(gate.value, 'unverified');
    assert.deepEqual(codes(gate), ['LEDGER_PAGINATION_INCOMPLETE', 'LEDGER_READ_NOT_CONSISTENT']);
  });

  it('leaves a snapshot without a consistent read unverified', () => {
    const gate = assess(
      edited(CONVENTIONAL_CONTROL, [{ op: 'set', path: LEDGER, pointer: '/consistent_read', value: false }]),
    );
    assert.equal(gate.value, 'unverified');
    assert.deepEqual(codes(gate), ['LEDGER_READ_NOT_CONSISTENT']);
  });

  it('invalidates a duplicate transaction id, which outranks the unverified problems', () => {
    const [first] = builtEvidence(CONVENTIONAL_TREATMENT).ledger.transactions;
    assert.ok(first !== undefined);
    const gate = assess(
      edited(CONVENTIONAL_TREATMENT, [
        {
          op: 'set',
          path: LEDGER,
          pointer: '/transactions/1/provider_transaction_id',
          value: first.provider_transaction_id,
        },
        { op: 'set', path: LEDGER, pointer: '/pages/0/next_cursor', value: 'page-2' },
        { op: 'set', path: LEDGER, pointer: '/consistent_read', value: false },
      ]),
    );
    assert.equal(gate.value, 'invalid');
    assert.deepEqual(codes(gate), ['DUPLICATE_LEDGER_TRANSACTION_ID']);
    assert.match(gate.reasons[0]?.detail ?? '', /appears more than once; expected unique ids/);
  });
});
