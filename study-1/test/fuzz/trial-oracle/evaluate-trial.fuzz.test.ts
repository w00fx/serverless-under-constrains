// Design §12.5 and §8.1-§8.8 as properties over arbitrary edits of every trial base: the oracle
// never throws (A-05); it either refuses with reasons or returns a result and projection that hold
// their schemas and BR-RUA-035; and the result agrees with its own parts: validity is the BR-RUA-029
// derivation of its gates, the verdict never passes an invalid or indeterminate trial or a failed
// business rule, a conclusive monetary rule rests on verified G1, G5 and G6 (D-15), completion
// follows BR-RUA-030, and an indeterminate verdict always carries its reasons.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { validateResultReferences } from '../../../src/record-contract/evidence-refs.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import type { OracleResult } from '../../../src/record-contract/records/group-c/oracle_result.ts';
import { evaluateTrial } from '../../../src/trial-oracle/evaluate-trial.ts';
import { isVerdictBusinessRule } from '../../../src/trial-oracle/oracle-vocabulary.ts';
import { deriveCorrectCompletion } from '../../../src/trial-oracle/preservation-verdict.ts';
import { deriveTrialValidity } from '../../../src/trial-oracle/trial-validity.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { ORACLE_VALIDATOR } from '../../unit/trial-oracle/support/built-trials.ts';
import { UNIT_CHECKED_AT } from '../../unit/trial-oracle/support/evaluated-trials.ts';
import { editedTrialArbitrary, editedTrialEvidence } from './support/trial-file-edits.ts';

const MONETARY_RULES = new Set(['BR-RUA-001', 'BR-RUA-002', 'BR-RUA-009']);
const MONETARY_GATES = [0, 5, 6] as const;

function assertSelfConsistent(result: OracleResult): void {
  assert.equal(result.trial_validity, deriveTrialValidity(result.validity_gates));
  const business = result.rule_results.filter((rule) => isVerdictBusinessRule(rule.rule_id));
  if (result.preservation_verdict === 'pass') {
    assert.equal(result.trial_validity, 'valid');
    assert.ok(business.every((rule) => rule.result === 'pass' || rule.result === 'not_applicable'));
    assert.notEqual(result.processing_terminal_reason, null);
  }
  if (result.preservation_verdict === 'fail') {
    assert.equal(result.trial_validity, 'valid');
    assert.ok(business.some((rule) => rule.result === 'fail'));
  }
  if (result.preservation_verdict === 'indeterminate') {
    assert.ok(result.indeterminate_reasons.length > 0, 'an indeterminate verdict names its reasons');
  }
  const conclusiveMonetary = result.rule_results.some(
    (rule) => MONETARY_RULES.has(rule.rule_id) && (rule.result === 'pass' || rule.result === 'fail'),
  );
  if (conclusiveMonetary) {
    for (const index of MONETARY_GATES) {
      assert.equal(result.validity_gates[index].value, 'verified', result.validity_gates[index].gate);
    }
  }
  assert.equal(
    result.correct_completion,
    deriveCorrectCompletion(result.preservation_verdict, result.processing_terminal_reason),
  );
}

describe('the trial oracle over arbitrary evidence edits', () => {
  it('is total, schema-valid, referenced and consistent with its own parts', () => {
    fc.assert(
      fc.property(editedTrialArbitrary, (trial) => {
        const evaluated = evaluateTrial({ evidence: editedTrialEvidence(trial), checked_at: UNIT_CHECKED_AT });
        if (!evaluated.ok) {
          assert.ok(evaluated.error.length > 0, 'a refusal names its reasons');
          return;
        }
        const { result, projection } = evaluated.value;
        const resultCheck = ORACLE_VALIDATOR.validateAs('oracle_result', result as unknown as JsonValue);
        assert.ok(resultCheck.valid, JSON.stringify(resultCheck.valid ? [] : resultCheck.violations));
        const projectionCheck = ORACLE_VALIDATOR.validateAs('attempt_projection', projection as unknown as JsonValue);
        assert.ok(projectionCheck.valid, JSON.stringify(projectionCheck.valid ? [] : projectionCheck.violations));
        for (const rule of result.rule_results) {
          if (rule.result !== 'not_applicable') {
            assert.deepEqual(
              validateResultReferences(rule.result, rule.evidence_refs, rule.indeterminate_reasons),
              [],
              rule.rule_id,
            );
          }
        }
        assertSelfConsistent(result);
      }),
      fuzzParameters(),
    );
  });
});
