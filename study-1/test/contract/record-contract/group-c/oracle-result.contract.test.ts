// AC-RUA-046 (group C, row 67): the cross-field rules of the oracle result. Each case breaks one
// rule of a spec-faithful example (one BR-RUA-029 matrix row each) and expects the rejection at
// the member that rule governs; the accepted cases pin the branch the rule deliberately leaves
// open. Sources: BR-RUA-006, BR-RUA-029, BR-RUA-030, BR-RUA-035, INV-RUA-001, design §8.3-§8.8,
// D-04, D-05 and D-17; D-15 and the design §8.10 fidelity rules are in
// oracle-result-derivations.contract.test.ts.

import { describe, it } from 'node:test';

import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';
import {
  assertAccepted,
  assertForbidden,
  assertRejected,
} from '../../../support/record-contract/group-b-validation.ts';
import { withValueAt } from '../../../support/record-contract/json-paths.ts';
import { PROBE_ID, VALIDATION_ID, toJson } from '../../../support/record-contract/record-builders.ts';
import {
  controlFailOracleResult,
  controlPassOracleResult,
  indeterminateOracleResult,
  invalidTreatmentOracleResult,
  treatmentPassOracleResult,
  validIndeterminateOracleResult,
} from './examples/oracle-examples.ts';
import { arrayAt, edited } from './support/json-edits.ts';

const control = toJson(controlPassOracleResult());
const controlFail = toJson(controlFailOracleResult());
const treatment = toJson(treatmentPassOracleResult());
const indeterminate = toJson(indeterminateOracleResult());
const invalidTreatment = toJson(invalidTreatmentOracleResult());
const validIndeterminate = toJson(validIndeterminateOracleResult());

/** Positions in `validity_gates` (design §8.3) and `rule_results` (design §6.3). */
const GATE = { g3: 2, g4a: 3, g4b: 4, g6: 6 } as const;
const RULE = { br001: 0, br004: 3, br005: 4, br007: 5, br008: 6, inv001: 8, br025: 9 } as const;

function gateValue(json: JsonObject, position: number, value: string): JsonValue {
  return withValueAt(json, ['validity_gates', position, 'value'], value);
}

function ruleResult(json: JsonObject, position: number, value: string): JsonValue {
  return withValueAt(json, ['rule_results', position, 'result'], value);
}

describe('AC-RUA-046 oracle_result: the examples are the BR-RUA-029 matrix rows', () => {
  it('every example is accepted', () => {
    assertAccepted(control, 'row 1: valid control pass');
    assertAccepted(treatment, 'row 7: verified treatment pass, terminal DLQ');
    assertAccepted(indeterminate, 'row 8: processing active at deadline');
    assertAccepted(invalidTreatment, 'row 4a: invalid treatment with two transactions');
    assertAccepted(controlFail, 'row 10: proven duplicate');
    assertAccepted(validIndeterminate, 'valid trial with an indeterminate business rule');
  });
});

describe('AC-RUA-046 oracle_result: validity and verdict (BR-RUA-006, BR-RUA-029)', () => {
  it('a pass or fail needs a valid trial', () => {
    assertRejected(
      edited(control, { trial_validity: 'indeterminate' }),
      'pass of an indeterminate trial',
      '/trial_validity const',
    );
    assertRejected(
      edited(controlFail, { trial_validity: 'invalid' }),
      'fail of an invalid trial',
      '/trial_validity const',
    );
  });

  it('trial_validity follows the gate precedence: invalid > unverified > valid', () => {
    assertRejected(
      edited(indeterminate, { trial_validity: 'invalid' }),
      'invalid without an invalid gate',
      '/validity_gates contains',
    );
    assertRejected(
      edited(indeterminate, { trial_validity: 'valid' }),
      'valid with an unverified gate',
      '/validity_gates/0/value enum',
    );
    assertRejected(
      edited(invalidTreatment, { trial_validity: 'indeterminate' }),
      'indeterminate with an invalid gate',
      '/validity_gates/4/value enum',
    );
    assertRejected(
      edited(validIndeterminate, { trial_validity: 'indeterminate' }),
      'indeterminate without an unverified gate',
      '/validity_gates contains',
    );
    assertRejected(
      gateValue(control, GATE.g6, 'invalid'),
      'valid with an invalid gate',
      '/validity_gates/6/value enum',
    );
  });

  it('the verdict of a valid trial follows its business rules', () => {
    assertRejected(
      edited(validIndeterminate, { preservation_verdict: 'pass', correct_completion: false }),
      'pass with an indeterminate business rule',
      '/rule_results/3/result enum',
    );
    assertRejected(
      edited(control, { preservation_verdict: 'fail', correct_completion: false }),
      'fail without a failed business rule',
      '/rule_results anyOf',
    );
    assertRejected(
      edited(controlFail, { preservation_verdict: 'indeterminate', correct_completion: null }),
      'indeterminate with a failed business rule',
      '/rule_results/0/result enum',
    );
    assertRejected(
      edited(control, { preservation_verdict: 'indeterminate', correct_completion: null }),
      'indeterminate without an indeterminate business rule',
      '/rule_results anyOf',
    );
    // Matrix row 4: a non-valid trial reports the rule failures and stays indeterminate.
    assertAccepted(ruleResult(invalidTreatment, RULE.br004, 'fail'), 'non-valid trial with a business fail');
  });
});

describe('AC-RUA-046 oracle_result: gates (design §8.3)', () => {
  it('G4a is applicable exactly on CONTROL, G4b exactly on a treatment trial', () => {
    assertRejected(gateValue(control, GATE.g4b, 'verified'), 'control with G4b', '/validity_gates/4/value const');
    assertRejected(
      gateValue(control, GATE.g4a, 'not_applicable'),
      'control without G4a',
      '/validity_gates/3/value enum',
    );
    assertRejected(gateValue(treatment, GATE.g4a, 'verified'), 'treatment with G4a', '/validity_gates/3/value const');
    assertRejected(
      gateValue(treatment, GATE.g4b, 'not_applicable'),
      'treatment without G4b',
      '/validity_gates/4/value enum',
    );
  });

  it('every other gate is always applicable', () => {
    for (const position of [0, 1, 2, 5, 6, 7, 8]) {
      assertRejected(
        gateValue(control, position, 'not_applicable'),
        `gate ${String(position)} not applicable`,
        `/validity_gates/${String(position)}/value enum`,
      );
    }
  });

  it('the top-level integrity fields equal their gates (INV-RUA-001: never not_applicable)', () => {
    assertRejected(
      edited(control, { identity_integrity: 'not_applicable' }),
      'identity n/a',
      '/identity_integrity enum',
    );
    assertRejected(
      edited(control, { identity_integrity: 'unverified' }),
      'identity mirror',
      '/validity_gates/2/value const',
    );
    assertRejected(
      edited(control, { control_integrity: 'invalid' }),
      'control mirror',
      '/validity_gates/3/value const',
    );
    assertRejected(
      edited(treatment, { treatment_fidelity: 'unverified' }),
      'fidelity mirror',
      '/validity_gates/4/value const',
    );
    assertRejected(gateValue(control, GATE.g3, 'invalid'), 'G3 against the top level', '/validity_gates/2/value const');
  });

  it('a verified settlement gate has a terminal reason (D-17)', () => {
    assertRejected(
      edited(validIndeterminate, { processing_terminal_reason: null }),
      'verified G6 without a terminal reason',
      '/processing_terminal_reason not',
    );
    assertAccepted(edited(indeterminate, { processing_terminal_reason: 'INTERRUPTED' }), 'unverified G6 with a reason');
  });
});

describe('AC-RUA-046 oracle_result: rules (design §8.5, D-04)', () => {
  it('BR-RUA-007 is not_applicable per trial: it is evaluated in the comparison', () => {
    for (const result of ['pass', 'fail', 'indeterminate']) {
      assertRejected(ruleResult(control, RULE.br007, result), `BR-RUA-007 ${result}`, '/rule_results/5/result const');
    }
  });

  it('the mirror rules follow their gates', () => {
    assertRejected(
      ruleResult(control, RULE.br005, 'indeterminate'),
      'BR-RUA-005 vs G1',
      '/rule_results/4/result const',
    );
    assertRejected(ruleResult(control, RULE.br008, 'fail'), 'BR-RUA-008 vs G2', '/rule_results/6/result const');
    assertRejected(
      ruleResult(control, RULE.inv001, 'indeterminate'),
      'INV-RUA-001 vs G3',
      '/rule_results/8/result const',
    );
    assertRejected(
      ruleResult(control, RULE.br025, 'not_applicable'),
      'BR-RUA-025 vs G4a',
      '/rule_results/9/result const',
    );
    assertRejected(
      ruleResult(treatment, RULE.br025, 'fail'),
      'BR-RUA-025 vs G4b verified',
      '/rule_results/9/result const',
    );
    assertRejected(
      ruleResult(indeterminate, RULE.br025, 'pass'),
      'BR-RUA-025 vs G4b unverified',
      '/rule_results/9/result const',
    );
    assertRejected(
      ruleResult(invalidTreatment, RULE.br025, 'indeterminate'),
      'BR-RUA-025 vs G4b invalid',
      '/rule_results/9/result const',
    );
    assertRejected(
      ruleResult(indeterminate, RULE.br005, 'pass'),
      'BR-RUA-005 vs unverified G1',
      '/rule_results/4/result const',
    );
  });

  it('a pass or fail result cites evidence; an indeterminate or not_applicable one may not (BR-RUA-035)', () => {
    assertRejected(
      withValueAt(control, ['rule_results', RULE.br001, 'evidence_refs'], []),
      'pass without reference',
      '/rule_results/0/evidence_refs minItems',
    );
    assertRejected(
      withValueAt(controlFail, ['rule_results', RULE.br001, 'evidence_refs'], []),
      'fail without reference',
      '/rule_results/0/evidence_refs minItems',
    );
    assertRejected(
      withValueAt(treatment, ['treatment_condition_results', 0, 'evidence_refs'], []),
      'pass condition without reference',
      '/treatment_condition_results/0/evidence_refs minItems',
    );
    assertAccepted(
      withValueAt(indeterminate, ['rule_results', RULE.br001, 'evidence_refs'], []),
      'indeterminate without reference',
    );
    assertAccepted(
      withValueAt(control, ['rule_results', RULE.br007, 'evidence_refs'], []),
      'not_applicable without reference',
    );
  });
});

describe('AC-RUA-046 oracle_result: completion and terminal reason (BR-RUA-030, D-17)', () => {
  it('correct_completion follows the verdict and the terminal reason', () => {
    assertRejected(
      edited(control, { correct_completion: false }),
      'SUCCEEDED pass not correct',
      '/correct_completion const',
    );
    assertRejected(
      edited(control, { correct_completion: null }),
      'pass with null completion',
      '/correct_completion const',
    );
    assertRejected(
      edited(treatment, { correct_completion: true }),
      'exhausted pass correct',
      '/correct_completion const',
    );
    assertRejected(edited(controlFail, { correct_completion: true }), 'fail correct', '/correct_completion const');
    assertRejected(edited(controlFail, { correct_completion: null }), 'fail null', '/correct_completion const');
    assertRejected(
      edited(indeterminate, { correct_completion: false }),
      'indeterminate false',
      '/correct_completion const',
    );
    assertRejected(
      edited(indeterminate, { correct_completion: true }),
      'indeterminate true',
      '/correct_completion const',
    );
  });

  it('a pass or fail always has a terminal reason; an unsettled indeterminate may have none', () => {
    assertRejected(
      edited(control, { processing_terminal_reason: null }),
      'pass without reason',
      '/processing_terminal_reason enum',
    );
    assertRejected(
      edited(controlFail, { processing_terminal_reason: null }),
      'fail without reason',
      '/processing_terminal_reason enum',
    );
    assertAccepted(indeterminate, 'indeterminate without reason');
    assertRejected(
      edited(control, { processing_terminal_reason: 'TIMED_OUT' }),
      'unknown reason',
      '/processing_terminal_reason enum',
    );
  });
});

describe('AC-RUA-046 oracle_result: scenario shape (D-05)', () => {
  it('a CONTROL trial has no treatment assessment', () => {
    assertRejected(
      edited(control, { control_integrity: 'not_applicable' }),
      'control without integrity',
      '/control_integrity enum',
    );
    assertRejected(
      edited(control, { treatment_fidelity: 'verified' }),
      'control fidelity',
      '/treatment_fidelity const',
    );
    assertRejected(edited(control, { fidelity_basis: 'causal' }), 'control basis', '/fidelity_basis const');
    assertRejected(
      edited(control, { clock_assumption_refs: ['CA-1'] }),
      'control clock',
      '/clock_assumption_refs maxItems',
    );
    assertRejected(
      edited(control, { treatment_condition_results: treatment['treatment_condition_results'] }),
      'control conditions',
      '/treatment_condition_results maxItems',
    );
  });

  it('a treatment trial has six ordered conditions and a fidelity basis', () => {
    const conditions = arrayAt(treatment, 'treatment_condition_results');
    assertRejected(
      edited(treatment, { control_integrity: 'verified' }),
      'treatment control integrity',
      '/control_integrity const',
    );
    assertRejected(
      edited(treatment, { treatment_fidelity: 'not_applicable' }),
      'treatment fidelity n/a',
      '/treatment_fidelity enum',
    );
    assertRejected(
      edited(treatment, { fidelity_basis: 'not_applicable' }),
      'treatment basis n/a',
      '/fidelity_basis enum',
    );
    assertRejected(
      edited(treatment, { treatment_condition_results: conditions.slice(1) }),
      'five conditions',
      '/treatment_condition_results minItems',
    );
    assertRejected(
      edited(treatment, { treatment_condition_results: conditions.toReversed() }),
      'reversed conditions',
      '/treatment_condition_results/0/condition_id const',
    );
  });

  it('a clock-assumption basis names its assumption (CA-1)', () => {
    assertRejected(
      edited(treatment, { clock_assumption_refs: [] }),
      'assumed without CA-1',
      '/clock_assumption_refs minItems',
    );
    assertRejected(
      edited(treatment, { clock_assumption_refs: ['CA-1', 'CA-1'] }),
      'duplicate CA-1',
      '/clock_assumption_refs uniqueItems',
    );
    assertAccepted(
      edited(indeterminate, { fidelity_basis: 'causal', clock_assumption_refs: ['CA-1'] }),
      'an unverified fidelity on the spec causal basis may cite CA-1',
    );
    assertAccepted(
      edited(indeterminate, { fidelity_basis: 'causal', clock_assumption_refs: [] }),
      'an unverified fidelity on the spec causal basis may cite nothing',
    );
  });

  it('lists the nine gates and the ten rules in their fixed order', () => {
    const gates = arrayAt(control, 'validity_gates');
    const rules = arrayAt(control, 'rule_results');
    assertRejected(edited(control, { validity_gates: gates.slice(0, 8) }), 'eight gates', '/validity_gates minItems');
    assertRejected(
      edited(control, { validity_gates: [...gates.slice(1), gates[0] ?? null] }),
      'rotated gates',
      '/validity_gates/0/gate const',
    );
    assertRejected(
      edited(control, { rule_results: [...rules, rules[0] ?? null] }),
      'eleven rules',
      '/rule_results maxItems',
    );
    assertRejected(
      edited(control, { rule_results: rules.toReversed() }),
      'reversed rules',
      '/rule_results/0/rule_id const',
    );
  });

  it('names a run or a variant validation, never a probe', () => {
    assertRejected(edited(control, { variant_validation_id: VALIDATION_ID }), 'both executions', ' oneOf');
    assertRejected(edited(control, { run_id: undefined }), 'no execution', ' oneOf');
    assertForbidden(edited(control, { transport_probe_id: PROBE_ID }), 'probe oracle result', '/transport_probe_id');
  });
});
