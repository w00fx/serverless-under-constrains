// The ten rule results in their fixed order (design §6.3, §8.5), with the scenario mirror reading
// G4a for CONTROL and G4b for treatment.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ORACLE_RULE_IDS } from '../../../src/record-contract/records/group-c/vocabulary.ts';
import type { ValidityGate } from '../../../src/record-contract/records/group-c/oracle_result.ts';
import { readAttempts } from '../../../src/trial-oracle/attempt-facts.ts';
import { evaluateBusinessRules } from '../../../src/trial-oracle/business-rules.ts';
import type { BusinessRuleResults } from '../../../src/trial-oracle/business-rules.ts';
import type { MonetaryBasis } from '../../../src/trial-oracle/monetary-basis.ts';
import { businessInputs } from '../../../src/trial-oracle/oracle-inputs.ts';
import { assessTreatment, assessValidityGates } from '../../../src/trial-oracle/validity-gates.ts';
import type { NineGates } from '../../../src/trial-oracle/validity-gates.ts';
import { builtEvidence } from './support/built-trials.ts';
import type { TrialBuild } from './support/built-trials.ts';
import { CONVENTIONAL_CONTROL, CONVENTIONAL_TREATMENT } from './support/trial-plans.ts';

function rulesOf(
  build: TrialBuild,
  override?: (gates: NineGates) => NineGates,
  basis: MonetaryBasis = { conclusive: true },
): BusinessRuleResults {
  const evidence = builtEvidence(build);
  const assessed = assessValidityGates(evidence, assessTreatment(evidence));
  const gates = override === undefined ? assessed.gates : override(assessed.gates);
  return evaluateBusinessRules(evidence, {
    basis,
    gates,
    inputs: businessInputs(evidence),
    attempts: readAttempts(evidence),
  });
}

const replaced = (gates: NineGates, index: number, gate: ValidityGate): NineGates =>
  gates.map((entry, at) => (at === index ? gate : entry)) as unknown as NineGates;

describe('evaluateBusinessRules', () => {
  it('lists the ten rules in the oracle result order', () => {
    assert.deepEqual(
      rulesOf(CONVENTIONAL_CONTROL).rules.map((rule) => rule.rule_id),
      [...ORACLE_RULE_IDS],
    );
  });

  it('mirrors G4a for a CONTROL trial and G4b for a treatment trial', () => {
    const control = rulesOf(CONVENTIONAL_CONTROL).rules[9];
    assert.deepEqual(control.observed, { gate: 'control_integrity', value: 'verified' });
    const treatment = rulesOf(CONVENTIONAL_TREATMENT).rules[9];
    assert.deepEqual(treatment.observed, { gate: 'treatment_fidelity', value: 'verified' });
  });

  it('mirrors G1, G2 and G3 in BR-RUA-005, BR-RUA-008 and INV-RUA-001', () => {
    const invalidated = (gates: NineGates): NineGates =>
      [0, 1, 2].reduce(
        (current, index) => replaced(current, index, { ...current[index], value: 'invalid' } as ValidityGate),
        gates,
      );
    const { rules } = rulesOf(CONVENTIONAL_CONTROL, invalidated);
    assert.deepEqual([rules[4].result, rules[6].result, rules[8].result], ['fail', 'fail', 'fail']);
  });

  it('gives BR-RUA-003 the identity integrity value and the monetary rules their basis', () => {
    const unverifiedIdentity = (gates: NineGates): NineGates =>
      replaced(gates, 2, { ...gates[2], value: 'unverified' });
    const reason = { code: 'LEDGER_INCOMPLETE', subject: 'BR-RUA-005', detail: 'not complete' };
    const { rules, monetary_observations } = rulesOf(CONVENTIONAL_CONTROL, unverifiedIdentity, {
      conclusive: false,
      reasons: [reason],
    });
    assert.equal(rules[2].result, 'indeterminate');
    assert.deepEqual(
      [rules[0].result, rules[1].result, rules[7].result],
      ['indeterminate', 'indeterminate', 'indeterminate'],
    );
    assert.equal(monetary_observations.successful_transaction_count, 1);
  });

  it('judges BR-RUA-007 per comparison, never per trial', () => {
    assert.equal(rulesOf(CONVENTIONAL_CONTROL).rules[5].result, 'not_applicable');
  });
});
