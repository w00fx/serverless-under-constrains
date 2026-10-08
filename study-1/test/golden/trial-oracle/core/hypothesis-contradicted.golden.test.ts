// AC-RUA-012 golden (BR-RUA-006, -043), oracle side: a treatment trial whose evidence contradicts the
// initial hypothesis (one transaction, not two) is evaluated as its evidence gives it. The oracle
// result reports the pass and the observed single transaction, with nothing filtered out: every
// transaction of the ledger is in the monetary observations and the projection, and evaluating
// the same evidence again gives the same result. The run-summary side is the study-comparison
// golden `ac012-summary-includes-all-four`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { coreMismatches, evaluateCoreCase } from './support/oracle-golden.ts';

describe('AC-RUA-012 result does not follow the hypothesis', () => {
  it('ac012-oracle-results-unaltered', async () => {
    assert.deepEqual(await coreMismatches('ac012-oracle-results-unaltered'), []);
  });

  it('ac012-oracle-results-unaltered reports every ledger transaction, the same on every evaluation', async () => {
    const first = await evaluateCoreCase('ac012-oracle-results-unaltered');
    const second = await evaluateCoreCase('ac012-oracle-results-unaltered');
    const { result, projection } = first.evaluation;
    assert.deepEqual(
      result.monetary_observations.provider_transaction_ids,
      projection.transactions.map((transaction) => transaction.provider_transaction_id),
    );
    assert.deepEqual(second.evaluation, first.evaluation);
  });
});
