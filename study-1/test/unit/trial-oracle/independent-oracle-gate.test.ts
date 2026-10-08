// Gate G1 `independent_oracle` (BR-RUA-005): a consistent snapshot by the evidence collector,
// captured inside the re-derived settled window.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GateAssessment } from '../../../src/evidence-ingestion/ingestion-model.ts';
import { assessIndependentOracle } from '../../../src/trial-oracle/independent-oracle-gate.ts';
import { readTrialSettlement } from '../../../src/trial-oracle/trial-settlement.ts';
import { builtEvidence } from './support/built-trials.ts';
import type { TrialBuild } from './support/built-trials.ts';
import { ACTIVE_CONTROL, CONVENTIONAL_CONTROL, edited } from './support/trial-plans.ts';

const LEDGER = '$trial/ledger/ledger-snapshot.json';

function assess(build: TrialBuild): GateAssessment<'independent_oracle'> {
  const evidence = builtEvidence(build);
  return assessIndependentOracle(evidence, readTrialSettlement(evidence));
}

function settledWindow(): { readonly established_at: string; readonly rechecked_at: string } {
  const derived = readTrialSettlement(builtEvidence(CONVENTIONAL_CONTROL)).derived;
  assert.ok(derived?.status === 'established');
  return derived;
}

const codes = (gate: ReturnType<typeof assess>): readonly string[] => gate.reasons.map((reason) => reason.code);

describe('assessIndependentOracle', () => {
  it('verifies a consistent collector snapshot captured inside the settled window', () => {
    const gate = assess(CONVENTIONAL_CONTROL);
    assert.equal(gate.gate, 'independent_oracle');
    assert.equal(gate.value, 'verified');
    assert.equal(gate.evidence_refs.length, 1);
  });

  it('accepts a capture at either end of the window', () => {
    const window = settledWindow();
    for (const instant of [window.established_at, window.rechecked_at]) {
      const gate = assess(
        edited(CONVENTIONAL_CONTROL, [{ op: 'set', path: LEDGER, pointer: '/captured_at', value: instant }]),
      );
      assert.equal(gate.value, 'verified', instant);
    }
  });

  it('leaves an absent snapshot unverified with ARTIFACT_MISSING and no reference', () => {
    const gate = assess(edited(CONVENTIONAL_CONTROL, [{ op: 'delete_file', path: LEDGER }]));
    assert.equal(gate.value, 'unverified');
    assert.deepEqual(codes(gate), ['ARTIFACT_MISSING']);
    assert.deepEqual(gate.evidence_refs, []);
  });

  it('leaves an unreadable snapshot unverified with ARTIFACT_INCOMPLETE', () => {
    const gate = assess(edited(CONVENTIONAL_CONTROL, [{ op: 'truncate', path: LEDGER, length: 20 }]));
    assert.equal(gate.value, 'unverified');
    assert.deepEqual(codes(gate), ['ARTIFACT_INCOMPLETE']);
  });

  it('invalidates an inconsistent read and a snapshot by another writer', () => {
    const gate = assess(
      edited(CONVENTIONAL_CONTROL, [
        { op: 'set', path: LEDGER, pointer: '/consistent_read', value: false },
        { op: 'set', path: LEDGER, pointer: '/writer', value: 'runner' },
      ]),
    );
    assert.equal(gate.value, 'invalid');
    assert.deepEqual(codes(gate), ['LEDGER_NOT_INDEPENDENT', 'LEDGER_READ_NOT_CONSISTENT']);
    assert.match(gate.reasons[0]?.detail ?? '', /written by runner; expected evidence_collector/);
  });

  it('reports an invalid snapshot without the unverified window problems', () => {
    const gate = assess(
      edited(ACTIVE_CONTROL, [{ op: 'set', path: LEDGER, pointer: '/consistent_read', value: false }]),
    );
    assert.equal(gate.value, 'invalid');
    assert.deepEqual(codes(gate), ['LEDGER_READ_NOT_CONSISTENT']);
  });

  it('leaves the gate unverified when settlement is not established', () => {
    const gate = assess(ACTIVE_CONTROL);
    assert.equal(gate.value, 'unverified');
    assert.deepEqual(codes(gate), ['SETTLEMENT_NOT_ESTABLISHED']);
  });

  it('leaves a capture before establishment or after the recheck unverified', () => {
    const window = settledWindow();
    const before = new Date(Date.parse(window.established_at) - 1).toISOString();
    const after = new Date(Date.parse(window.rechecked_at) + 1).toISOString();
    for (const instant of [before, after]) {
      const gate = assess(
        edited(CONVENTIONAL_CONTROL, [{ op: 'set', path: LEDGER, pointer: '/captured_at', value: instant }]),
      );
      assert.equal(gate.value, 'unverified', instant);
      assert.deepEqual(codes(gate), ['LEDGER_CAPTURED_OUTSIDE_SETTLED_WINDOW']);
    }
  });
});
