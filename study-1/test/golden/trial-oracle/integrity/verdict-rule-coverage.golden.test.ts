// AC-RUA-055 rule-coverage golden (BR-RUA-055, design D-18): "the oracle's golden cases for every
// verdict-changing rule pass". Every reachable `(rule, outcome)` pair of every verdict-changing id
// is declared by a trial-oracle golden case; every pair a case declares is one its evaluation
// reaches; and no case reaches a pair outside the reachable set, so the set is complete. The
// per-suite goldens prove each case's expectation; this suite also proves the cases it adds.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { VERDICT_CHANGING_RULES } from '../../../../src/trial-oracle/oracle-vocabulary.ts';
import { evaluateCaseFile, integrityMismatches } from './support/integrity-golden.ts';
import type { IntegrityEvaluation } from './support/integrity-golden.ts';
import {
  REACHABLE_RULE_OUTCOMES,
  TRIAL_ORACLE_CASE_FILES,
  declaredPairs,
  reachablePairs,
  reachedPairs,
} from './support/rule-coverage.ts';

let evaluated: Promise<readonly IntegrityEvaluation[]> | undefined;

// Every trial-oracle case is evaluated once, when a test first asks, so a failure is that test's.
function evaluatedCases(): Promise<readonly IntegrityEvaluation[]> {
  evaluated ??= Promise.all(TRIAL_ORACLE_CASE_FILES.map((caseFile) => evaluateCaseFile(caseFile)));
  return evaluated;
}

describe('AC-RUA-055 verdict-changing rule coverage', () => {
  it('names every verdict-changing id', () => {
    assert.deepEqual([...REACHABLE_RULE_OUTCOMES.keys()].toSorted(), [...VERDICT_CHANGING_RULES].toSorted());
    assert.ok(TRIAL_ORACLE_CASE_FILES.length > 0, 'no trial-oracle case was found; expected the golden cases');
  });

  it('every reachable pair is declared by a case', async () => {
    const declared = new Set((await evaluatedCases()).flatMap(({ loaded }) => declaredPairs(loaded)));
    assert.deepEqual(
      reachablePairs().filter((pair) => !declared.has(pair)),
      [],
    );
  });

  it('every declared pair is reached by its case', async () => {
    const unreached = (await evaluatedCases()).flatMap(({ loaded, evaluation }) => {
      const reached = new Set(reachedPairs(evaluation));
      return declaredPairs(loaded)
        .filter((pair) => !reached.has(pair))
        .map((pair) => `${loaded.golden_case.case_id}: ${pair}`);
    });
    assert.deepEqual(unreached, []);
  });

  it('no case reaches a pair outside the reachable set', async () => {
    const reachable = new Set(reachablePairs());
    const outside = (await evaluatedCases()).flatMap(({ loaded, evaluation }) =>
      reachedPairs(evaluation)
        .filter((pair) => !reachable.has(pair))
        .map((pair) => `${loaded.golden_case.case_id}: ${pair}`),
    );
    assert.deepEqual(outside, []);
  });
});

describe('AC-RUA-055 rule-coverage cases', () => {
  it('ledger-not-independent', async () => {
    assert.deepEqual(await integrityMismatches('ledger-not-independent'), []);
  });
  it('duplicate-ledger-transaction', async () => {
    assert.deepEqual(await integrityMismatches('duplicate-ledger-transaction'), []);
  });
  it('settlement-rederivation-mismatch', async () => {
    assert.deepEqual(await integrityMismatches('settlement-rederivation-mismatch'), []);
  });
  it('unknown-outcome-not-recorded', async () => {
    assert.deepEqual(await integrityMismatches('unknown-outcome-not-recorded'), []);
  });
  it('evidence-index-missing', async () => {
    assert.deepEqual(await integrityMismatches('evidence-index-missing'), []);
  });
});
