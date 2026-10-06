// AC-RUA-046 (group C, row 67): the oracle-result rules that follow approved derivations rather
// than single members: D-15 (the monetary rules conclude only on a usable, settled, independent
// ledger), the always-applicable monetary rules of design §8.5, and the design §8.10 treatment
// fidelity under CA-1 (AC-RUA-002, D-05). It also checks that the schema's repeated mirror blocks
// are exactly the ones `support/oracle-result-rules.ts` generates.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isJsonArray, isJsonObject } from '../../../../src/record-contract/json-value.ts';
import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';
import { assertAccepted, assertRejected } from '../../../support/record-contract/group-b-validation.ts';
import { withValueAt } from '../../../support/record-contract/json-paths.ts';
import { toJson } from '../../../support/record-contract/record-builders.ts';
import {
  controlPassOracleResult,
  indeterminateOracleResult,
  invalidTreatmentOracleResult,
  treatmentPassOracleResult,
} from './examples/oracle-examples.ts';
import { edited, recordWithValueAt } from './support/json-edits.ts';
import { GENERATED_RULES_START, generatedOracleRules, withGeneratedRules } from './support/oracle-result-rules.ts';
import { groupCSchemaOf } from './support/schema-reading.ts';

const control = toJson(controlPassOracleResult());
const treatment = toJson(treatmentPassOracleResult());
const indeterminate = toJson(indeterminateOracleResult());
const invalidTreatment = toJson(invalidTreatmentOracleResult());

/** Positions in `validity_gates` (design §8.3) and `rule_results` (design §6.3). */
const GATE = { g1: 0, g4b: 4, g5: 5, g6: 6 } as const;
const RULE = { br001: 0, br002: 1, br004: 3, br009: 7, br025: 9 } as const;
/** BR-RUA-001, -002 and -009: the monetary rules of design §8.5. */
const MONETARY_RULES = [RULE.br001, RULE.br002, RULE.br009] as const;

function ruleResult(json: JsonObject, position: number, value: string): JsonValue {
  return withValueAt(json, ['rule_results', position, 'result'], value);
}

describe('AC-RUA-046 oracle_result: generated mirror blocks', () => {
  it('the schema holds exactly the generated integrity and mirror blocks', () => {
    const schema = groupCSchemaOf('oracle_result');
    const generated = generatedOracleRules();
    assert.equal(generated.length, 26);
    const allOf = isJsonObject(schema) && isJsonArray(schema['allOf']) ? schema['allOf'] : [];
    assert.deepEqual(allOf.slice(GENERATED_RULES_START, GENERATED_RULES_START + generated.length), [...generated]);
    assert.deepEqual(withGeneratedRules(schema), schema);
  });
});

describe('AC-RUA-046 oracle_result: monetary basis and treatment fidelity (D-15, design §8.5, §8.10)', () => {
  it('BR-RUA-001, -002 and -009 are always applicable', () => {
    for (const position of MONETARY_RULES) {
      assertRejected(
        ruleResult(control, position, 'not_applicable'),
        `monetary rule ${String(position)} not_applicable`,
        `/rule_results/${String(position)}/result enum`,
      );
    }
    const allNotApplicable = MONETARY_RULES.reduce<JsonObject>(
      (record, position) => recordWithValueAt(record, ['rule_results', position, 'result'], 'not_applicable'),
      control,
    );
    assertRejected(
      allNotApplicable,
      'a pass whose monetary rules are all not_applicable',
      '/rule_results/7/result enum',
    );
  });

  it('the monetary rules conclude only when G1, G5 and G6 are verified (D-15)', () => {
    // invalidTreatment: G1, G5 and G6 verified, so its monetary fails are conclusive (matrix row 4).
    for (const gate of [GATE.g1, GATE.g5, GATE.g6]) {
      for (const value of ['unverified', 'invalid']) {
        const unusable = recordWithValueAt(invalidTreatment, ['validity_gates', gate, 'value'], value);
        assertRejected(
          unusable,
          `fail on a ledger whose gate ${String(gate)} is ${value}`,
          '/rule_results/0/result const',
        );
        const concluded = recordWithValueAt(unusable, ['rule_results', RULE.br001, 'result'], 'indeterminate');
        assertRejected(
          concluded,
          `only BR-RUA-001 indeterminate, gate ${String(gate)} ${value}`,
          '/rule_results/1/result const',
        );
      }
    }
    // indeterminate: G1 and G6 unverified, so its monetary rules are indeterminate.
    for (const position of MONETARY_RULES) {
      assertRejected(
        ruleResult(indeterminate, position, 'pass'),
        `monetary rule ${String(position)} concluded on an unsettled ledger`,
        `/rule_results/${String(position)}/result const`,
      );
    }
    assertAccepted(indeterminate, 'all three indeterminate on an unsettled ledger');
    // Only the three monetary rules are tied to the ledger gates.
    assertAccepted(
      ruleResult(indeterminate, RULE.br004, 'fail'),
      'BR-RUA-004 reads the caller journal, not the ledger',
    );
  });

  it('verified fidelity has six passing conditions under CA-1 (design §8.10, AC-RUA-002, D-05)', () => {
    for (const result of ['indeterminate', 'fail']) {
      assertRejected(
        withValueAt(treatment, ['treatment_condition_results', 2, 'result'], result),
        `verified fidelity with a ${result} condition`,
        '/treatment_condition_results/2/result const',
      );
    }
    assertRejected(
      edited(treatment, { fidelity_basis: 'causal', clock_assumption_refs: [] }),
      'verified fidelity on a causal basis without CA-1',
      '/fidelity_basis const',
    );
    assertRejected(
      edited(treatment, { fidelity_basis: 'causal' }),
      'verified fidelity on a causal basis with CA-1',
      '/fidelity_basis const',
    );
  });

  it('an unaffected failing condition makes fidelity invalid; an affected one does not (design §8.10)', () => {
    // invalidTreatment: BR-RUA-013 fails on unaffected evidence and G4b is invalid.
    const asUnverified = edited(
      recordWithValueAt(invalidTreatment, ['validity_gates', GATE.g4b, 'value'], 'unverified'),
      { treatment_fidelity: 'unverified', trial_validity: 'indeterminate' },
    );
    const mirrored = recordWithValueAt(asUnverified, ['rule_results', RULE.br025, 'result'], 'indeterminate');
    assertRejected(mirrored, 'unverified fidelity with an unaffected failing condition', '/treatment_fidelity const');
    const affected = recordWithValueAt(
      mirrored,
      ['treatment_condition_results', 3, 'affected_by'],
      ['CAUSAL_PREDECESSOR_MISSING'],
    );
    assertAccepted(affected, 'an affected failing condition leaves fidelity unverified');
  });
});
