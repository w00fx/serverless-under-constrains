// classifyDynamoError over arbitrary thrown values (testing rule 6: the classifier reads
// untrusted SDK errors). The example cases are in
// test/unit/durable-store/dynamo-error-classification.test.ts; the property lives here so
// `npm run test:fuzz` and `fuzz:campaign` reach it (Owner amendment A-11).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { classifyDynamoError, DEFINITIVE_ERROR_NAMES } from '../../../src/durable-store/dynamo-error-classification.ts';
import { deepAttributeValueLike } from '../../support/durable-store/arbitraries.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

describe('classifyDynamoError properties', () => {
  it('is total, and only listed names or cancellations are ever definitive', () => {
    const errorLike = fc.oneof(
      fc.anything(),
      fc.record({ name: fc.oneof(fc.string(), fc.constantFrom(...DEFINITIVE_ERROR_NAMES)), code: fc.anything() }),
      fc.record({
        name: fc.constantFrom('TransactionCanceledException', 'ConditionalCheckFailedException'),
        CancellationReasons: fc.anything(),
        Item: fc.anything(),
      }),
      fc.record({
        name: fc.constant('ConditionalCheckFailedException'),
        Item: fc.record({ pk: fc.constant({ S: 'p' }), sk: fc.constant({ S: 's' }), deep: deepAttributeValueLike }),
      }),
    );
    fc.assert(
      fc.property(errorLike, (error) => {
        const outcome = classifyDynamoError(error);
        assert.notEqual(outcome.kind, 'applied');
        if (outcome.kind === 'definitive_failure') {
          const name = (error as { readonly name?: unknown }).name;
          assert.ok(DEFINITIVE_ERROR_NAMES.has(outcome.code) || name === 'TransactionCanceledException', outcome.code);
        }
        if (outcome.kind === 'condition_failed') {
          assert.ok(Number.isSafeInteger(outcome.failed_action_index) && outcome.failed_action_index >= 0);
        }
      }),
      fuzzParameters(),
    );
  });
});
