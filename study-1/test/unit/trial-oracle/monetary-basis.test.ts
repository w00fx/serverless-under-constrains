// The D-15 monetary basis: conclusive only when G1, G5 and G6 are verified and the ledger, payment
// and decision are present; otherwise the reasons name each blocking gate at the ledger snapshot,
// or each missing input at its path.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GateValue } from '../../../src/record-contract/primitives.ts';
import type { GateId } from '../../../src/record-contract/records/group-c/vocabulary.ts';
import { deriveMonetaryBasis } from '../../../src/trial-oracle/monetary-basis.ts';
import type { MonetaryInputs } from '../../../src/trial-oracle/monetary-basis.ts';

const LEDGER = 'trials/t/ledger/ledger-snapshot.json';
const PAYMENT = 'trials/t/inputs/payment.json';
const DECISION = 'trials/t/inputs/approved-decision.json';

const PRESENT: MonetaryInputs = {
  ledger: { given: true, present: true, path: LEDGER },
  payment: { given: true, present: true, path: PAYMENT },
  decision: { given: true, present: true, path: DECISION },
};

function gates(oracle: GateValue, access: GateValue, settlement: GateValue): ReadonlyMap<GateId, GateValue> {
  return new Map<GateId, GateValue>([
    ['independent_oracle', oracle],
    ['ledger_access', access],
    ['settlement', settlement],
  ]);
}

describe('deriveMonetaryBasis', () => {
  it('is conclusive with G1, G5 and G6 verified and every input present', () => {
    assert.deepEqual(deriveMonetaryBasis(gates('verified', 'verified', 'verified'), PRESENT), { conclusive: true });
  });

  it('names each gate that is not verified, at the ledger snapshot, in G1, G5, G6 order', () => {
    const basis = deriveMonetaryBasis(gates('invalid', 'unverified', 'unverified'), PRESENT);
    assert.equal(basis.conclusive, false);
    assert.ok(!basis.conclusive);
    assert.deepEqual(
      basis.reasons.map((reason) => [reason.code, reason.artifact_path, reason.subject]),
      [
        ['LEDGER_NOT_INDEPENDENT', LEDGER, 'BR-RUA-005'],
        ['LEDGER_INCOMPLETE', LEDGER, 'BR-RUA-005'],
        ['SETTLEMENT_NOT_ESTABLISHED', LEDGER, 'BR-RUA-005'],
      ],
    );
    assert.match(basis.reasons[0]?.detail ?? '', /the gate is invalid; expected verified/);
  });

  it('reports an absent gate value as absent', () => {
    const basis = deriveMonetaryBasis(new Map<GateId, GateValue>(), PRESENT);
    assert.ok(!basis.conclusive);
    assert.equal(basis.reasons.length, 3);
    assert.match(basis.reasons[2]?.detail ?? '', /the gate is absent; expected verified/);
  });

  it('names only the missing ledger when no snapshot exists, whatever the gates say', () => {
    const inputs: MonetaryInputs = { ...PRESENT, ledger: { given: false, present: false, path: LEDGER } };
    const basis = deriveMonetaryBasis(gates('unverified', 'unverified', 'unverified'), inputs);
    assert.ok(!basis.conclusive);
    assert.deepEqual(
      basis.reasons.map((reason) => [reason.code, reason.artifact_path]),
      [['ARTIFACT_MISSING', LEDGER]],
    );
  });

  it('calls a given but unusable ledger incomplete, not missing', () => {
    const inputs: MonetaryInputs = { ...PRESENT, ledger: { given: true, present: false, path: LEDGER } };
    const basis = deriveMonetaryBasis(gates('verified', 'verified', 'verified'), inputs);
    assert.ok(!basis.conclusive);
    assert.deepEqual(
      basis.reasons.map((reason) => reason.code),
      ['ARTIFACT_INCOMPLETE'],
    );
  });

  it('names a missing payment and decision with INPUT_MISSING at their paths', () => {
    const inputs: MonetaryInputs = {
      ...PRESENT,
      payment: { given: false, present: false, path: PAYMENT },
      decision: { given: true, present: false, path: DECISION },
    };
    const basis = deriveMonetaryBasis(gates('verified', 'verified', 'verified'), inputs);
    assert.ok(!basis.conclusive);
    assert.deepEqual(
      basis.reasons.map((reason) => [reason.code, reason.artifact_path]),
      [
        ['INPUT_MISSING', PAYMENT],
        ['INPUT_MISSING', DECISION],
      ],
    );
    assert.match(basis.reasons[0]?.detail ?? '', /gives no usable payment; expected it for the monetary rules/);
  });
});
