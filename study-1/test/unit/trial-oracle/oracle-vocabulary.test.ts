// The verdict-changing ids (design §8.6, AC-RUA-055): the nine gates, the five BR-RUA-006 business
// rules and the three derivations, in that order.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GATE_IDS, ORACLE_RULE_IDS } from '../../../src/record-contract/records/group-c/vocabulary.ts';
import {
  isVerdictBusinessRule,
  VERDICT_BUSINESS_RULES,
  VERDICT_CHANGING_RULES,
  VERDICT_DERIVATION_RULES,
} from '../../../src/trial-oracle/oracle-vocabulary.ts';

describe('oracle vocabulary', () => {
  it('lists the gates, then the business rules, then the derivations', () => {
    assert.deepEqual(VERDICT_CHANGING_RULES, [...GATE_IDS, ...VERDICT_BUSINESS_RULES, ...VERDICT_DERIVATION_RULES]);
    assert.equal(VERDICT_CHANGING_RULES.length, 17);
  });

  it('names BR-RUA-001, -002, -003, -004 and -009 as the business rules', () => {
    assert.deepEqual(VERDICT_BUSINESS_RULES, ['BR-RUA-001', 'BR-RUA-002', 'BR-RUA-003', 'BR-RUA-004', 'BR-RUA-009']);
  });

  it('recognises exactly the business rules among the oracle rule ids', () => {
    const recognised = ORACLE_RULE_IDS.filter((ruleId) => isVerdictBusinessRule(ruleId));
    assert.deepEqual(recognised, [...VERDICT_BUSINESS_RULES]);
  });
});
