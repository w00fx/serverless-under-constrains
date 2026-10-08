// The gate mirrors (design §8.5): verified passes, invalid fails, unverified and not applicable are
// indeterminate with the gate's reasons; BR-RUA-007 is judged per comparison.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GateValue } from '../../../src/record-contract/primitives.ts';
import type { ValidityGate } from '../../../src/record-contract/records/group-c/oracle_result.ts';
import { equalTreatmentRule, mirrorRule } from '../../../src/trial-oracle/mirror-rules.ts';

const REF = { artifact_path: 'trials/t/ledger/ledger-snapshot.json', artifact_sha256: 'a'.repeat(64) } as const;
const REASON = {
  code: 'ARTIFACT_MISSING',
  subject: 'BR-RUA-005',
  artifact_path: REF.artifact_path,
  detail: 'absent',
} as const;

function gate(value: GateValue): ValidityGate {
  return {
    gate: 'independent_oracle',
    value,
    reasons: value === 'verified' ? [] : [REASON],
    evidence_refs: [REF] as unknown as ValidityGate['evidence_refs'],
  };
}

describe('mirrorRule', () => {
  it('passes a verified gate with its references', () => {
    const rule = mirrorRule('BR-RUA-005', gate('verified'));
    assert.equal(rule.result, 'pass');
    assert.deepEqual(rule.evidence_refs, [REF]);
    assert.deepEqual(rule.indeterminate_reasons, []);
    assert.deepEqual(rule.expected, { gate: 'independent_oracle', value: 'verified' });
    assert.deepEqual(rule.observed, { gate: 'independent_oracle', value: 'verified' });
  });

  it('fails an invalid gate without indeterminate reasons', () => {
    const rule = mirrorRule('BR-RUA-005', gate('invalid'));
    assert.equal(rule.result, 'fail');
    assert.deepEqual(rule.indeterminate_reasons, []);
  });

  it('is indeterminate with the gate reasons for an unverified or not-applicable gate', () => {
    for (const value of ['unverified', 'not_applicable'] as const) {
      const rule = mirrorRule('INV-RUA-001', gate(value));
      assert.equal(rule.result, 'indeterminate', value);
      assert.deepEqual(rule.indeterminate_reasons, [REASON]);
      assert.equal(rule.rule_id, 'INV-RUA-001');
    }
  });
});

describe('equalTreatmentRule', () => {
  it('is not applicable per trial, citing nothing', () => {
    assert.deepEqual(equalTreatmentRule(), {
      rule_id: 'BR-RUA-007',
      result: 'not_applicable',
      expected: { evaluated_in: 'comparison' },
      observed: { code: 'EVALUATED_IN_COMPARISON' },
      evidence_refs: [],
      indeterminate_reasons: [],
    });
  });
});
