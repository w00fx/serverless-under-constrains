// The projection fields a reassessment compares (D-16): verdict, validity, every gate, every rule
// outcome and correct_completion, each named by its JSON Pointer into the oracle result.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { projectionChanges } from '../../../../src/trial-oracle/late-evidence/projection-changes.ts';
import type { VerdictProjection } from '../../../../src/trial-oracle/verdict-projection.ts';

const ORACLE_GATE = { gate: 'independent_oracle', value: 'verified' } as const;
const TRACEABILITY_GATE = { gate: 'traceability', value: 'verified' } as const;
const RULE_001 = { rule_id: 'BR-RUA-001', result: 'pass' } as const;
const RULE_004 = { rule_id: 'BR-RUA-004', result: 'not_applicable' } as const;
const FROZEN: VerdictProjection = {
  preservation_verdict: 'pass',
  trial_validity: 'valid',
  gates: [ORACLE_GATE, TRACEABILITY_GATE],
  rules: [RULE_001, RULE_004],
  correct_completion: true,
};

describe('projectionChanges', () => {
  it('finds nothing in an identical projection', () => {
    assert.deepEqual(projectionChanges(FROZEN, structuredClone(FROZEN)), []);
  });

  it('names every changed field in result order', () => {
    const reassessed: VerdictProjection = {
      ...FROZEN,
      preservation_verdict: 'fail',
      trial_validity: 'indeterminate',
      gates: [ORACLE_GATE, { gate: 'traceability', value: 'unverified' }],
      rules: [{ rule_id: 'BR-RUA-001', result: 'fail' }, RULE_004],
      correct_completion: null,
    };
    assert.deepEqual(projectionChanges(FROZEN, reassessed), [
      { field: '/preservation_verdict', frozen: 'pass', reassessed: 'fail' },
      { field: '/trial_validity', frozen: 'valid', reassessed: 'indeterminate' },
      { field: '/validity_gates/1/value', frozen: 'verified', reassessed: 'unverified' },
      { field: '/rule_results/0/result', frozen: 'pass', reassessed: 'fail' },
      { field: '/correct_completion', frozen: true, reassessed: null },
    ]);
  });

  it('names a field one side lacks, reading the missing value as null', () => {
    const shorter: VerdictProjection = { ...FROZEN, rules: [RULE_001] };
    const missing = [
      { field: '/rule_results/1/rule_id', frozen: 'BR-RUA-004', reassessed: null },
      { field: '/rule_results/1/result', frozen: 'not_applicable', reassessed: null },
    ];
    assert.deepEqual(projectionChanges(FROZEN, shorter), missing);
    assert.deepEqual(
      projectionChanges(shorter, FROZEN),
      missing.map((change) => ({ field: change.field, frozen: null, reassessed: change.frozen })),
    );
  });

  it('compares gate and rule identities, not only their values', () => {
    const renamed: VerdictProjection = {
      ...FROZEN,
      gates: [ORACLE_GATE, { gate: 'ledger_access', value: 'verified' }],
    };
    assert.deepEqual(projectionChanges(FROZEN, renamed), [
      { field: '/validity_gates/1/gate', frozen: 'traceability', reassessed: 'ledger_access' },
    ]);
  });
});
