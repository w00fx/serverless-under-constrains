// The nine validity gates in G1-G8 order and the scenario side they depend on (design §8.3).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GATE_IDS } from '../../../src/record-contract/records/group-c/vocabulary.ts';
import { assessTreatment, assessValidityGates } from '../../../src/trial-oracle/validity-gates.ts';
import type { TrialGates } from '../../../src/trial-oracle/validity-gates.ts';
import { builtEvidence } from './support/built-trials.ts';
import type { TrialBuild } from './support/built-trials.ts';
import {
  ACTIVE_CONTROL,
  CONVENTIONAL_CONTROL,
  CONVENTIONAL_TREATMENT,
  DURABLE_CONTROL,
  DURABLE_TREATMENT,
} from './support/trial-plans.ts';

function gatesOf(build: TrialBuild): TrialGates {
  const evidence = builtEvidence(build);
  return assessValidityGates(evidence, assessTreatment(evidence));
}

const values = (build: TrialBuild): readonly string[] => gatesOf(build).gates.map((gate) => gate.value);

describe('assessTreatment', () => {
  it('judges a CONTROL trial by control integrity alone', () => {
    for (const build of [CONVENTIONAL_CONTROL, DURABLE_CONTROL]) {
      assert.deepEqual(assessTreatment(builtEvidence(build)), { scenario: 'CONTROL' }, build.base);
    }
  });

  it('gives a treatment trial its six conditions and fidelity', () => {
    for (const build of [CONVENTIONAL_TREATMENT, DURABLE_TREATMENT]) {
      const treatment = assessTreatment(builtEvidence(build));
      assert.ok(treatment.scenario === 'COMMIT_THEN_TIMEOUT', build.base);
      assert.equal(treatment.conditions.length, 6);
      assert.equal(treatment.fidelity.treatment_fidelity, 'verified');
    }
  });
});

describe('assessValidityGates', () => {
  it('lists the nine gates in G1-G8 order', () => {
    assert.deepEqual(
      gatesOf(CONVENTIONAL_CONTROL).gates.map((gate) => gate.gate),
      [...GATE_IDS],
    );
  });

  it('verifies every applicable gate of a settled CONTROL trial; G4b does not apply', () => {
    assert.deepEqual(values(CONVENTIONAL_CONTROL), [
      'verified',
      'verified',
      'verified',
      'verified',
      'not_applicable',
      'verified',
      'verified',
      'verified',
      'verified',
    ]);
  });

  it('verifies every applicable gate of a settled treatment trial; G4a does not apply', () => {
    const gates = gatesOf(CONVENTIONAL_TREATMENT);
    assert.equal(gates.gates[3].value, 'not_applicable');
    assert.equal(gates.gates[4].value, 'verified');
    assert.ok(gates.gates[4].evidence_refs.length > 0);
    assert.equal(gates.terminal.reason, 'SUCCEEDED');
  });

  it('shares the terminal derivation with G6: no terminal reason leaves settlement unverified', () => {
    const gates = gatesOf(ACTIVE_CONTROL);
    assert.equal(gates.terminal.reason, null);
    assert.equal(gates.gates[6].value, 'unverified');
    assert.ok(gates.gates[6].reasons.some((reason) => reason.code === 'PROCESSING_NOT_TERMINAL'));
  });
});
