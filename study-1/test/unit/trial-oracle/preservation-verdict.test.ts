// BR-RUA-006 preservation verdict and BR-RUA-030 correct completion (design §8.6, §8.8).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RuleOutcomeEntry } from '../../../src/trial-oracle/preservation-verdict.ts';
import { deriveCorrectCompletion, derivePreservationVerdict } from '../../../src/trial-oracle/preservation-verdict.ts';

const PASSING: readonly RuleOutcomeEntry[] = [
  { rule_id: 'BR-RUA-001', result: 'pass' },
  { rule_id: 'BR-RUA-002', result: 'pass' },
  { rule_id: 'BR-RUA-003', result: 'pass' },
  { rule_id: 'BR-RUA-004', result: 'not_applicable' },
  { rule_id: 'BR-RUA-009', result: 'pass' },
];

describe('derivePreservationVerdict', () => {
  it('passes a valid trial whose business rules pass or do not apply', () => {
    assert.equal(derivePreservationVerdict('valid', PASSING), 'pass');
  });

  it('is indeterminate for an indeterminate or invalid trial, whatever the rules say', () => {
    const failing: readonly RuleOutcomeEntry[] = [{ rule_id: 'BR-RUA-001', result: 'fail' }];
    assert.equal(derivePreservationVerdict('indeterminate', failing), 'indeterminate');
    assert.equal(derivePreservationVerdict('invalid', failing), 'indeterminate');
  });

  it('fails a valid trial with a failing business rule, even beside an indeterminate one', () => {
    const rules: readonly RuleOutcomeEntry[] = [
      ...PASSING,
      { rule_id: 'BR-RUA-004', result: 'indeterminate' },
      { rule_id: 'BR-RUA-009', result: 'fail' },
    ];
    assert.equal(derivePreservationVerdict('valid', rules), 'fail');
  });

  it('is indeterminate for a valid trial with an indeterminate business rule and no failure', () => {
    assert.equal(
      derivePreservationVerdict('valid', [...PASSING, { rule_id: 'BR-RUA-004', result: 'indeterminate' }]),
      'indeterminate',
    );
  });

  it('ignores the rules that mirror gates or are judged per comparison', () => {
    const rules: readonly RuleOutcomeEntry[] = [
      ...PASSING,
      { rule_id: 'BR-RUA-005', result: 'fail' },
      { rule_id: 'BR-RUA-008', result: 'indeterminate' },
      { rule_id: 'INV-RUA-001', result: 'fail' },
      { rule_id: 'BR-RUA-025', result: 'fail' },
      { rule_id: 'BR-RUA-007', result: 'indeterminate' },
    ];
    assert.equal(derivePreservationVerdict('valid', rules), 'pass');
  });
});

describe('deriveCorrectCompletion', () => {
  it('is null for an indeterminate verdict', () => {
    assert.equal(deriveCorrectCompletion('indeterminate', 'SUCCEEDED'), null);
  });

  it('is false for a failed verdict, whatever the terminal reason', () => {
    assert.equal(deriveCorrectCompletion('fail', 'SUCCEEDED'), false);
    assert.equal(deriveCorrectCompletion('fail', null), false);
  });

  it('is true only for a pass with a SUCCEEDED terminal reason', () => {
    assert.equal(deriveCorrectCompletion('pass', 'SUCCEEDED'), true);
  });

  it('is false for a pass with a non-successful terminal reason (AC-RUA-052)', () => {
    for (const terminal of [
      'RETRIES_EXHAUSTED',
      'MESSAGE_REJECTED',
      'PROVIDER_REJECTED',
      'INTERRUPTED',
      'SAFETY_DEADLINE',
    ] as const) {
      assert.equal(deriveCorrectCompletion('pass', terminal), false, terminal);
    }
  });

  it('is null for a pass without a terminal reason (total, though unreachable through evaluateTrial)', () => {
    assert.equal(deriveCorrectCompletion('pass', null), null);
  });
});
