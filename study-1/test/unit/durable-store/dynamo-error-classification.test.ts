// SDK error → WriteOutcome. Error objects are built from the SDK's own exception classes, so
// the shapes are the ones the adapter receives (name, $fault, Item, CancellationReasons).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ConditionalCheckFailedException,
  DynamoDBServiceException,
  InternalServerError,
  TransactionCanceledException,
  TransactionInProgressException,
} from '@aws-sdk/client-dynamodb';
import fc from 'fast-check';

import {
  classifyDynamoError,
  DEFINITIVE_ERROR_NAMES,
  errorCode,
} from '../../../src/durable-store/dynamo-error-classification.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const META = { $metadata: { httpStatusCode: 400 }, message: 'rejected' };

// ValidationException is a common DynamoDB error without a modeled class; the SDK surfaces it
// as a DynamoDBServiceException carrying the name.
const validationError = new DynamoDBServiceException({ ...META, name: 'ValidationException', $fault: 'client' });

function cancelled(reasons: TransactionCanceledException['CancellationReasons']): TransactionCanceledException {
  return new TransactionCanceledException({ ...META, CancellationReasons: reasons });
}

describe('classifyDynamoError', () => {
  it('a single conditional write failure is condition_failed at index 0 with the ALL_OLD item', () => {
    const error = new ConditionalCheckFailedException({
      ...META,
      Item: { pk: { S: 'p' }, sk: { S: 'lease' }, owner_id: { S: 'other' } },
    });
    assert.deepEqual(classifyDynamoError(error), {
      kind: 'condition_failed',
      failed_action_index: 0,
      existing: { pk: 'p', sk: 'lease', owner_id: 'other' },
    });
    assert.deepEqual(classifyDynamoError(new ConditionalCheckFailedException(META)), {
      kind: 'condition_failed',
      failed_action_index: 0,
    });
  });

  it('a cancelled transaction reports the first failed condition with its item', () => {
    const outcome = classifyDynamoError(
      cancelled([
        { Code: 'None' },
        { Code: 'ConditionalCheckFailed', Item: { pk: { S: 'p' }, sk: { S: 'treatment' }, state: { S: 'CONSUMED' } } },
        { Code: 'ConditionalCheckFailed' },
      ]),
    );
    assert.deepEqual(outcome, {
      kind: 'condition_failed',
      failed_action_index: 1,
      existing: { pk: 'p', sk: 'treatment', state: 'CONSUMED' },
    });
  });

  it('a failed condition outranks other cancellation reasons', () => {
    assert.deepEqual(
      classifyDynamoError(cancelled([{ Code: 'TransactionConflict' }, { Code: 'ConditionalCheckFailed' }])),
      {
        kind: 'condition_failed',
        failed_action_index: 1,
      },
    );
  });

  it('a failed condition whose item does not decode keeps the certain condition failure', () => {
    assert.deepEqual(classifyDynamoError(cancelled([{ Code: 'ConditionalCheckFailed', Item: { pk: { N: '1' } } }])), {
      kind: 'condition_failed',
      failed_action_index: 0,
    });
  });

  it('other cancellations are definitive, named by the first real reason code', () => {
    assert.deepEqual(
      classifyDynamoError(cancelled([{ Code: 'None' }, {}, { Code: '' }, { Code: 'TransactionConflict' }])),
      {
        kind: 'definitive_failure',
        code: 'TransactionConflict',
      },
    );
    assert.deepEqual(classifyDynamoError(cancelled([{ Code: 'None' }, { Code: 'ValidationError' }])), {
      kind: 'definitive_failure',
      code: 'ValidationError',
    });
    assert.deepEqual(classifyDynamoError(cancelled([{ Code: 'None' }])), {
      kind: 'definitive_failure',
      code: 'TransactionCanceledException',
    });
    assert.deepEqual(classifyDynamoError(cancelled(undefined)), {
      kind: 'definitive_failure',
      code: 'TransactionCanceledException',
    });
  });

  it('documented rejections are definitive', () => {
    for (const name of DEFINITIVE_ERROR_NAMES) {
      assert.deepEqual(classifyDynamoError({ name, $fault: 'client' }), { kind: 'definitive_failure', code: name });
    }
    assert.deepEqual(classifyDynamoError(validationError), {
      kind: 'definitive_failure',
      code: 'ValidationException',
    });
    assert.equal(DEFINITIVE_ERROR_NAMES.size, 13);
  });

  it('server faults, in-progress tokens, timeouts, network and unknown errors are ambiguous', () => {
    assert.deepEqual(
      classifyDynamoError(new InternalServerError({ $metadata: { httpStatusCode: 500 }, message: 'x' })),
      {
        kind: 'ambiguous',
        code: 'InternalServerError',
      },
    );
    assert.deepEqual(classifyDynamoError(new TransactionInProgressException(META)), {
      kind: 'ambiguous',
      code: 'TransactionInProgressException',
    });
    assert.deepEqual(classifyDynamoError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), {
      kind: 'ambiguous',
      code: 'ECONNRESET',
    });
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    assert.deepEqual(classifyDynamoError(timeout), { kind: 'ambiguous', code: 'TimeoutError' });
    assert.deepEqual(classifyDynamoError(new SyntaxError('Unexpected token')), {
      kind: 'ambiguous',
      code: 'SyntaxError',
    });
    assert.deepEqual(classifyDynamoError('boom'), { kind: 'ambiguous', code: 'NonErrorThrown' });
    assert.deepEqual(classifyDynamoError(null), { kind: 'ambiguous', code: 'NonErrorThrown' });
  });
});

describe('errorCode', () => {
  it('prefers a specific name, falls back to a system code for generic errors', () => {
    assert.equal(errorCode(validationError), 'ValidationException');
    assert.equal(errorCode(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), 'ETIMEDOUT');
    assert.equal(errorCode({ code: 'EPIPE' }), 'EPIPE');
    assert.equal(errorCode(Object.assign(new TypeError('x'), { code: 'ERR_X' })), 'TypeError');
    assert.equal(errorCode(Object.assign(new Error('x'), { code: '' })), 'Error');
    assert.equal(errorCode(Object.assign(new Error('x'), { code: 7 })), 'Error');
    assert.equal(errorCode({ name: '' }), 'UnknownError');
    assert.equal(errorCode({ name: 42 }), 'UnknownError');
    assert.equal(errorCode({}), 'UnknownError');
    assert.equal(errorCode(undefined), 'NonErrorThrown');
    assert.equal(errorCode(12), 'NonErrorThrown');
  });
});

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
