// BR-RUA-001, -002 and -009 and the monetary observations (design §8.5, D-15): judged on the ledger,
// the payment and the decision alone, conclusive only on a conclusive basis.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MonetaryBasis } from '../../../src/trial-oracle/monetary-basis.ts';
import { evaluateMonetaryRules } from '../../../src/trial-oracle/monetary-rules.ts';
import type { MonetaryRuleResults } from '../../../src/trial-oracle/monetary-rules.ts';
import { businessInputs } from '../../../src/trial-oracle/oracle-inputs.ts';
import { builtEvidence } from './support/built-trials.ts';
import type { TrialBuild } from './support/built-trials.ts';
import { CONVENTIONAL_CONTROL, CONVENTIONAL_TREATMENT, edited } from './support/trial-plans.ts';

const CONCLUSIVE: MonetaryBasis = { conclusive: true };
const LEDGER = '$trial/ledger/ledger-snapshot.json';

function evaluate(build: TrialBuild, basis: MonetaryBasis = CONCLUSIVE): MonetaryRuleResults {
  const evidence = builtEvidence(build);
  return evaluateMonetaryRules(evidence, businessInputs(evidence), basis);
}

const cited = (
  refs: readonly { readonly artifact_path: string; readonly json_pointer?: string }[],
): readonly string[] =>
  refs.map((ref) => `${ref.artifact_path.replace(/^trials\/[0-9a-f-]+\//, '')}${ref.json_pointer ?? ''}`);

const singleTransaction = (attempt: Readonly<Record<string, string | number>>): TrialBuild => ({
  base: 'run-conventional-control',
  plan: { deliveries: [{ attempts: [{ behavior: 'succeeded', ...attempt }] }], processing: 'completes' },
});

describe('evaluateMonetaryRules', () => {
  it('passes the exact authorized effect, citing the ledger, its transaction and the inputs', () => {
    const rules = evaluate(CONVENTIONAL_CONTROL);
    assert.deepEqual(
      [rules.one_effect.result, rules.payment_limit.result, rules.exact_effect.result],
      ['pass', 'pass', 'pass'],
    );
    assert.deepEqual(cited(rules.one_effect.evidence_refs), [
      'inputs/approved-decision.json',
      'inputs/payment.json',
      'ledger/ledger-snapshot.json',
      'ledger/ledger-snapshot.json/transactions/0',
    ]);
    assert.deepEqual(rules.one_effect.expected, { count: 1, refund_request_id: 'ref-poc-001' });
    assert.deepEqual(rules.payment_limit.observed, { total_minor: '10000', transaction_count: 1 });
    assert.deepEqual(rules.observations.successful_transaction_count, 1);
    assert.equal(rules.observations.refunded_total_minor, '10000');
    assert.equal(rules.observations.ledger_complete, true);
  });

  it('fails all three on two full refunds, with their ids and sum observed', () => {
    const rules = evaluate(CONVENTIONAL_TREATMENT);
    assert.deepEqual(
      [rules.one_effect.result, rules.payment_limit.result, rules.exact_effect.result],
      ['fail', 'fail', 'fail'],
    );
    const observed = rules.one_effect.observed as {
      readonly count: number;
      readonly provider_transaction_ids: readonly string[];
    };
    assert.equal(observed.count, 2);
    assert.deepEqual(observed.provider_transaction_ids, rules.observations.provider_transaction_ids);
    assert.deepEqual(rules.payment_limit.observed, { total_minor: '20000', transaction_count: 2 });
    assert.deepEqual(rules.payment_limit.expected, { max_total_minor: 10000, payment_id: 'pay-poc-001' });
  });

  it('fails BR-RUA-009 alone on a wrong currency, naming the mismatching field', () => {
    const rules = evaluate(singleTransaction({ currency: 'USD' }));
    assert.deepEqual(
      [rules.one_effect.result, rules.payment_limit.result, rules.exact_effect.result],
      ['pass', 'pass', 'fail'],
    );
    const observed = rules.exact_effect.observed as {
      readonly transactions: readonly { readonly mismatches: readonly string[] }[];
    };
    assert.deepEqual(observed.transactions[0]?.mismatches, ['currency']);
  });

  it('counts only the transactions of the captured payment against its cap', () => {
    const rules = evaluate(singleTransaction({ payment_id: 'pay-poc-999', amount_minor: 20000 }));
    assert.equal(rules.payment_limit.result, 'pass');
    assert.deepEqual(rules.payment_limit.observed, { total_minor: '0', transaction_count: 0 });
    assert.equal(rules.exact_effect.result, 'fail');
  });

  it('is indeterminate on a basis that is not conclusive, with its reasons under each rule id', () => {
    const reason = { code: 'LEDGER_INCOMPLETE', subject: 'BR-RUA-005', detail: 'not complete' };
    const rules = evaluate(CONVENTIONAL_TREATMENT, { conclusive: false, reasons: [reason] });
    for (const rule of [rules.one_effect, rules.payment_limit, rules.exact_effect]) {
      assert.equal(rule.result, 'indeterminate', rule.rule_id);
      assert.deepEqual(rule.indeterminate_reasons, [{ ...reason, subject: rule.rule_id }]);
      assert.ok(rule.evidence_refs.length > 0);
    }
    assert.equal(rules.observations.successful_transaction_count, 2);
  });

  it('treats a missing decision as unknown: no count, and no mismatch on the fields it would give', () => {
    const rules = evaluate(
      edited(CONVENTIONAL_CONTROL, [{ op: 'delete_file', path: '$trial/inputs/approved-decision.json' }]),
    );
    assert.deepEqual(rules.one_effect.observed, { count: null, provider_transaction_ids: [] });
    assert.deepEqual(rules.one_effect.expected, { count: 1, refund_request_id: null });
    const observed = rules.exact_effect.observed as {
      readonly transactions: readonly { readonly mismatches: readonly string[] }[];
    };
    assert.deepEqual(observed.transactions[0]?.mismatches, []);
    assert.deepEqual(cited(rules.exact_effect.evidence_refs), [
      'inputs/payment.json',
      'ledger/ledger-snapshot.json',
      'ledger/ledger-snapshot.json/transactions/0',
    ]);
  });

  it('fails the cap without a payment, counting every transaction', () => {
    const rules = evaluate(edited(CONVENTIONAL_CONTROL, [{ op: 'delete_file', path: '$trial/inputs/payment.json' }]));
    assert.equal(rules.payment_limit.result, 'fail');
    assert.deepEqual(rules.payment_limit.expected, { max_total_minor: null, payment_id: null });
    assert.deepEqual(rules.payment_limit.observed, { total_minor: '10000', transaction_count: 1 });
  });

  it('cites only the inputs and observes nothing without a ledger snapshot', () => {
    const rules = evaluate(edited(CONVENTIONAL_CONTROL, [{ op: 'delete_file', path: LEDGER }]));
    assert.deepEqual(cited(rules.one_effect.evidence_refs), ['inputs/approved-decision.json', 'inputs/payment.json']);
    assert.deepEqual(rules.observations, {
      successful_transaction_count: 0,
      refunded_total_minor: '0',
      provider_transaction_ids: [],
      ledger_complete: false,
    });
  });
});
