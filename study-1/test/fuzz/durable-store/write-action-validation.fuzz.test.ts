// Totality of request validation and planning over generated write actions (testing rule 6,
// Owner amendment A-05; WP-04 review round 2): deep and wide conditions, invalid keys, names
// and numbers. Validation and planning must agree and never throw.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { toConditionExpression } from '../../../src/durable-store/condition-expression.ts';
import { planTransaction, planWrite } from '../../../src/durable-store/dynamodb-requests.ts';
import type { StoreTableNames } from '../../../src/durable-store/dynamodb-requests.ts';
import {
  conditionOperatorCount,
  MAX_EXPRESSION_BYTES,
  MAX_EXPRESSION_OPERATORS,
} from '../../../src/durable-store/expression-limits.ts';
import { validateTransaction, validateWriteAction } from '../../../src/durable-store/write-action-validation.ts';
import { hostileWriteAction } from '../../support/durable-store/arbitraries.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const TABLES: StoreTableNames = { ledger: 'l', control: 'c', caller_journal: 'j' };
const TOKEN = '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';

describe('write validation properties (WP-04 review round 2)', () => {
  it('validates and plans every generated action without throwing, and both agree', () => {
    fc.assert(
      fc.property(hostileWriteAction, (action) => {
        const violations = validateWriteAction(action);
        assert.ok(violations.every((violation) => typeof violation === 'string' && violation.includes('expected')));
        const plan = planWrite(TABLES, action);
        assert.equal(plan.ok, violations.length === 0);
        if (!plan.ok) {
          assert.deepEqual(plan.error, { kind: 'definitive_failure', code: 'ValidationException' });
        }
      }),
      fuzzParameters(),
    );
  });

  it('accepts only conditions whose expression fits 4 KB and 300 operators', () => {
    fc.assert(
      fc.property(hostileWriteAction, (action) => {
        if (validateWriteAction(action).length > 0 || action.condition === undefined) {
          return;
        }
        assert.ok(Buffer.byteLength(toConditionExpression(action.condition).expression) <= MAX_EXPRESSION_BYTES);
        assert.ok(conditionOperatorCount(action.condition) <= MAX_EXPRESSION_OPERATORS);
      }),
      fuzzParameters(),
    );
  });

  it('validates and plans every generated transaction without throwing, and both agree', () => {
    fc.assert(
      fc.property(fc.array(hostileWriteAction, { minLength: 0, maxLength: 3 }), (actions) => {
        const violations = validateTransaction(actions, TOKEN);
        const plan = planTransaction(TABLES, actions, TOKEN);
        assert.equal(plan.ok, violations.length === 0);
      }),
      fuzzParameters(),
    );
  });
});
