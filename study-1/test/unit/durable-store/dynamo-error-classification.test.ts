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

import {
  classifyDynamoError,
  DEFINITIVE_ERROR_NAMES,
  errorCode,
  UNREADABLE_ERROR_CODE,
} from '../../../src/durable-store/dynamo-error-classification.ts';

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

  // Until the M0 chores (Owner amendment A-11) only the classification property reached a
  // reason that is not an object; this case pins it at the unit boundary.
  it('skips cancellation reasons that are not objects', () => {
    const reasons: unknown = [null, 'ConditionalCheckFailed', 7, { Code: 'TransactionConflict' }];
    assert.deepEqual(classifyDynamoError({ name: 'TransactionCanceledException', CancellationReasons: reasons }), {
      kind: 'definitive_failure',
      code: 'TransactionConflict',
    });
  });

  it('documented rejections are definitive', () => {
    // Written from the AWS pages, not from the implementation (addendum §6): each name is a
    // documented rejection of the request that applied nothing.
    const documentedRejections: readonly (readonly [name: string, source: string])[] = [
      ['AccessDeniedException', 'CommonErrors.html'],
      ['IdempotentParameterMismatchException', 'API_TransactWriteItems.html Errors'],
      ['IncompleteSignatureException', 'CommonErrors.html'],
      ['ItemCollectionSizeLimitExceededException', 'API_PutItem.html Errors'],
      ['MissingAuthenticationTokenException', 'CommonErrors.html'],
      ['ProvisionedThroughputExceededException', 'API_PutItem.html Errors'],
      ['ReplicatedWriteConflictException', 'API_PutItem.html Errors'],
      ['RequestLimitExceeded', 'API_TransactWriteItems.html Errors'],
      ['ResourceNotFoundException', 'API_TransactWriteItems.html Errors'],
      ['ThrottlingException', 'CommonErrors.html'],
      ['TransactionConflictException', 'API_PutItem.html Errors'],
      ['UnrecognizedClientException', 'CommonErrors.html'],
      ['ValidationException', 'CommonErrors.html'],
    ];
    const expected = documentedRejections.map(([name]) => name);
    assert.deepEqual([...DEFINITIVE_ERROR_NAMES].sort(), [...expected].sort());
    for (const name of expected) {
      assert.deepEqual(classifyDynamoError({ name, $fault: 'client' }), { kind: 'definitive_failure', code: name });
    }
    assert.deepEqual(classifyDynamoError(validationError), {
      kind: 'definitive_failure',
      code: 'ValidationException',
    });
  });

  it('stays total when the ALL_OLD item nests past the limit (WP-04 review round 1)', () => {
    // JSON.parse builds 100,000 levels without recursion (A-05); the old decoder overflowed the stack.
    const deep = JSON.parse(`${'{"L":['.repeat(100_000)}{"S":"x"}${']}'.repeat(100_000)}`) as unknown;
    const item = { pk: { S: 'p' }, sk: { S: 's' }, deep };
    assert.deepEqual(classifyDynamoError(new ConditionalCheckFailedException({ ...META, Item: item as never })), {
      kind: 'condition_failed',
      failed_action_index: 0,
    });
    assert.deepEqual(classifyDynamoError(cancelled([{ Code: 'ConditionalCheckFailed', Item: item as never }])), {
      kind: 'condition_failed',
      failed_action_index: 0,
    });
  });

  it('keeps a certain condition failure on a non-finite or inherited-name ALL_OLD item (A-05)', () => {
    // JSON.parse('1e400') is Infinity: an N member decoded from an untrusted reply may be any text.
    const nonFinite = JSON.parse('{"pk":{"S":"p"},"sk":{"S":"s"},"n":{"N":"1e400"}}') as never;
    assert.deepEqual(classifyDynamoError(new ConditionalCheckFailedException({ ...META, Item: nonFinite })), {
      kind: 'condition_failed',
      failed_action_index: 0,
    });
    const numberNonFinite = JSON.parse('{"pk":{"S":"p"},"sk":{"S":"s"},"n":{"N":1e400}}') as never;
    assert.deepEqual(classifyDynamoError(cancelled([{ Code: 'ConditionalCheckFailed', Item: numberNonFinite }])), {
      kind: 'condition_failed',
      failed_action_index: 0,
    });
    const inherited = JSON.parse(
      '{"pk":{"S":"p"},"sk":{"S":"s"},"constructor":{"S":"c"},"toString":{"BOOL":true}}',
    ) as never;
    assert.deepEqual(classifyDynamoError(new ConditionalCheckFailedException({ ...META, Item: inherited })), {
      kind: 'condition_failed',
      failed_action_index: 0,
      existing: JSON.parse('{"pk":"p","sk":"s","constructor":"c","toString":true}') as never,
    });
    assert.deepEqual(
      classifyDynamoError(
        cancelled([{ Code: 'None' }, { Code: 'ConditionalCheckFailed', Item: { constructor: { S: 'c' } } }]),
      ),
      { kind: 'condition_failed', failed_action_index: 1 },
    );
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

describe('errors whose properties throw when read (WP-04 review round 1)', () => {
  it('are ambiguous with the UnreadableError code, never a throw', () => {
    const throwingName = {
      get name(): string {
        throw new Error('boom');
      },
    };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const throwingReasons = {
      name: 'TransactionCanceledException',
      get CancellationReasons(): unknown {
        throw new Error('boom');
      },
    };
    assert.equal(UNREADABLE_ERROR_CODE, 'UnreadableError');
    assert.deepEqual(classifyDynamoError(throwingName), { kind: 'ambiguous', code: 'UnreadableError' });
    assert.deepEqual(classifyDynamoError(revoked.proxy), { kind: 'ambiguous', code: 'UnreadableError' });
    assert.deepEqual(classifyDynamoError(throwingReasons), { kind: 'ambiguous', code: 'UnreadableError' });
    assert.equal(errorCode(throwingName), 'UnreadableError');
    assert.equal(errorCode(revoked.proxy), 'UnreadableError');
  });
});
