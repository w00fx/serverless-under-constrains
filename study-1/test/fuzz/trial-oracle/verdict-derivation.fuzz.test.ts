// Design §8.4-§8.8 and D-15 as properties over every combination of their inputs: BR-RUA-029
// validity precedence, the BR-RUA-006 verdict (never pass on a trial that is not valid or with a
// business rule that does not pass), BR-RUA-030 completion, and the monetary basis, conclusive
// exactly when G1, G5 and G6 are verified and every input is present.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { GateValue, RuleOutcome } from '../../../src/record-contract/primitives.ts';
import { PROCESSING_TERMINAL_REASONS } from '../../../src/record-contract/records/group-b/vocabulary.ts';
import {
  GATE_IDS,
  ORACLE_RULE_IDS,
  TRIAL_VALIDITIES,
} from '../../../src/record-contract/records/group-c/vocabulary.ts';
import type { GateId } from '../../../src/record-contract/records/group-c/vocabulary.ts';
import { deriveMonetaryBasis } from '../../../src/trial-oracle/monetary-basis.ts';
import { isVerdictBusinessRule } from '../../../src/trial-oracle/oracle-vocabulary.ts';
import { deriveCorrectCompletion, derivePreservationVerdict } from '../../../src/trial-oracle/preservation-verdict.ts';
import { deriveTrialValidity } from '../../../src/trial-oracle/trial-validity.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const GATE_VALUES: readonly GateValue[] = ['verified', 'invalid', 'unverified', 'not_applicable'];
const RULE_OUTCOMES: readonly RuleOutcome[] = ['pass', 'fail', 'indeterminate', 'not_applicable'];

const gateValueArbitrary = fc.constantFrom(...GATE_VALUES);
const rulesArbitrary = fc.array(
  fc.record({ rule_id: fc.constantFrom(...ORACLE_RULE_IDS), result: fc.constantFrom(...RULE_OUTCOMES) }),
  { maxLength: 12 },
);
const inputArbitrary = fc.record({
  given: fc.boolean(),
  present: fc.boolean(),
  path: fc.constantFrom('a.json', 'b.json'),
});

describe('verdict derivations over all their inputs', () => {
  it('rank validity invalid > unverified > verified, ignoring not-applicable gates', () => {
    fc.assert(
      fc.property(fc.array(gateValueArbitrary, { maxLength: 9 }), (values) => {
        const validity = deriveTrialValidity(values.map((value) => ({ value })));
        const expected = values.includes('invalid')
          ? 'invalid'
          : values.includes('unverified')
            ? 'indeterminate'
            : 'valid';
        assert.equal(validity, expected);
      }),
      fuzzParameters(),
    );
  });

  it('never pass a trial that is not valid or whose business rules do not all pass', () => {
    fc.assert(
      fc.property(fc.constantFrom(...TRIAL_VALIDITIES), rulesArbitrary, (validity, rules) => {
        const verdict = derivePreservationVerdict(validity, rules);
        const business = rules.filter((rule) => isVerdictBusinessRule(rule.rule_id)).map((rule) => rule.result);
        if (validity !== 'valid') {
          assert.equal(verdict, 'indeterminate');
          return;
        }
        const expected = business.includes('fail')
          ? 'fail'
          : business.includes('indeterminate')
            ? 'indeterminate'
            : 'pass';
        assert.equal(verdict, expected);
      }),
      fuzzParameters(),
    );
  });

  it('complete correctly only on a pass with a SUCCEEDED terminal reason', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('pass' as const, 'fail' as const, 'indeterminate' as const),
        fc.option(fc.constantFrom(...PROCESSING_TERMINAL_REASONS), { nil: null }),
        (verdict, terminal) => {
          const completion = deriveCorrectCompletion(verdict, terminal);
          assert.equal(completion === true, verdict === 'pass' && terminal === 'SUCCEEDED');
          assert.equal(completion === null, verdict === 'indeterminate' || (verdict === 'pass' && terminal === null));
        },
      ),
      fuzzParameters(),
    );
  });

  it('make the monetary basis conclusive exactly with G1, G5, G6 verified and every input present', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom(...GATE_IDS), gateValueArbitrary), { maxLength: 9 }),
        inputArbitrary,
        inputArbitrary,
        inputArbitrary,
        (entries, ledger, payment, decision) => {
          const gates = new Map<GateId, GateValue>(entries);
          const basis = deriveMonetaryBasis(gates, { ledger, payment, decision });
          const gatesVerified = (['independent_oracle', 'ledger_access', 'settlement'] as const).every(
            (gate) => gates.get(gate) === 'verified',
          );
          const inputsPresent = ledger.present && payment.present && decision.present;
          assert.equal(basis.conclusive, gatesVerified && inputsPresent);
          if (!basis.conclusive) {
            assert.ok(basis.reasons.length > 0);
            assert.ok(basis.reasons.every((reason) => reason.artifact_path !== undefined));
          }
        },
      ),
      fuzzParameters(),
    );
  });
});
