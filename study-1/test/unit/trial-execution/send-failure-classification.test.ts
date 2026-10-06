// The classification of a single-attempt SQS SendMessage or Lambda Invoke that threw (BR-RUA-020,
// BR-RUA-027, D-29): only an Error carrying its own `$fault: 'client'` and an integer HTTP status
// from 400 to 499 is a definitive rejection; everything else may hide a call that took effect.
// Total over hostile values (A-05). And the mapping of a returned SendMessage onto `sent`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifySendFailure,
  FAILURE_CODE_LIMIT,
  SEND_OUTPUT_INCOMPLETE,
  sentOutcomeOf,
} from '../../../src/trial-execution/send-failure-classification.ts';

function serviceError(name: string, fault: unknown, status: unknown): Error {
  return Object.assign(new Error(`scripted ${name}`), { name, $fault: fault, $metadata: { httpStatusCode: status } });
}

describe('classifySendFailure', () => {
  it('rejects a client-fault service exception with a 4xx status, naming it', () => {
    for (const status of [400, 403, 429, 499]) {
      const failure = classifySendFailure(serviceError('QueueDoesNotExist', 'client', status));
      assert.equal(failure.kind, 'rejected', String(status));
      assert.equal(failure.code, 'QueueDoesNotExist');
      assert.match(failure.detail, new RegExp(`HTTP ${String(status)}, client fault`));
      assert.match(failure.detail, /scripted QueueDoesNotExist/);
    }
  });

  it('reads any other fault or status as ambiguous', () => {
    const cases: readonly (readonly [unknown, unknown])[] = [
      ['server', 500],
      ['server', 400],
      ['client', 500],
      ['client', 399],
      ['client', 500.5],
      ['client', 404.5],
      ['client', '400'],
      ['client', undefined],
      [undefined, 400],
    ];
    for (const [fault, status] of cases) {
      const failure = classifySendFailure(serviceError('Scripted', fault, status));
      assert.equal(failure.kind, 'ambiguous', `${String(fault)} ${String(status)}`);
      assert.equal(failure.code, 'Scripted');
      assert.match(failure.detail, /no definitive client-fault response: scripted Scripted/);
    }
  });

  it('reads the SQS MD5 mismatch, a network error and a missing $metadata as ambiguous', () => {
    assert.deepEqual(classifySendFailure(new Error('InvalidChecksumError')), {
      kind: 'ambiguous',
      code: 'Error',
      detail: 'Error with no definitive client-fault response: InvalidChecksumError',
    });
    const reset = Object.assign(new Error('socket hang up'), { name: 'TimeoutError', $fault: 'client' });
    assert.equal(classifySendFailure(reset).kind, 'ambiguous');
  });

  it('reads members only when they are the error’s own', () => {
    const inherited = Object.create(serviceError('Inherited', 'client', 400)) as Error;
    assert.equal(classifySendFailure(inherited).kind, 'ambiguous');
    const metadataInherited = Object.assign(new Error('x'), { $fault: 'client' });
    Object.setPrototypeOf(
      metadataInherited,
      Object.assign(Object.create(Error.prototype) as object, { $metadata: { httpStatusCode: 400 } }),
    );
    assert.equal(classifySendFailure(metadataInherited).kind, 'ambiguous');
  });

  it('reads a value that is not an Error as ambiguous, even with a client fault', () => {
    const failure = classifySendFailure({ $fault: 'client', $metadata: { httpStatusCode: 400 } });
    assert.equal(failure.kind, 'ambiguous');
    assert.equal(failure.code, 'NonErrorThrown');
    assert.equal(classifySendFailure(undefined).code, 'NonErrorThrown');
  });

  it('never throws on a throwing getter or a hostile proxy', () => {
    const getter = new Error('getter');
    Object.defineProperty(getter, '$fault', {
      get: (): never => {
        throw new Error('boom');
      },
    });
    assert.equal(classifySendFailure(getter).kind, 'ambiguous');
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: (): never => {
          throw new Error('trap');
        },
      },
    );
    assert.deepEqual(classifySendFailure(hostile).kind, 'ambiguous');
    assert.equal(classifySendFailure(hostile).code, 'UnrepresentableThrown');
  });

  it('bounds the code to FAILURE_CODE_LIMIT characters', () => {
    const failure = classifySendFailure(serviceError('N'.repeat(FAILURE_CODE_LIMIT + 50), 'client', 400));
    assert.equal(failure.code, `${'N'.repeat(FAILURE_CODE_LIMIT)}…[truncated]`);
  });
});

describe('sentOutcomeOf', () => {
  const output = { MessageId: 'm-1', SequenceNumber: '18', MD5OfMessageBody: 'abc', $metadata: {} };

  it('maps the three members onto sent', () => {
    assert.deepEqual(sentOutcomeOf(output), {
      kind: 'sent',
      message_id: 'm-1',
      sequence_number: '18',
      md5_of_message_body: 'abc',
    });
  });

  it('reads a missing, empty, mistyped or inherited member as ambiguous', () => {
    const incomplete = { kind: 'ambiguous', code: SEND_OUTPUT_INCOMPLETE };
    for (const member of ['MessageId', 'SequenceNumber', 'MD5OfMessageBody'] as const) {
      const { [member]: _dropped, ...rest } = output;
      assert.deepEqual(sentOutcomeOf(rest), incomplete, member);
      assert.deepEqual(sentOutcomeOf({ ...output, [member]: '' }), incomplete, member);
      assert.deepEqual(sentOutcomeOf({ ...output, [member]: 7 }), incomplete, member);
      assert.deepEqual(sentOutcomeOf(Object.assign(Object.create({ [member]: 'x' }) as object, rest)), incomplete);
    }
    assert.deepEqual(sentOutcomeOf(undefined), incomplete);
    assert.deepEqual(sentOutcomeOf('sent'), incomplete);
  });

  it('never throws on a throwing getter', () => {
    const hostile = { ...output };
    Object.defineProperty(hostile, 'MessageId', {
      get: (): never => {
        throw new Error('boom');
      },
    });
    assert.deepEqual(sentOutcomeOf(hostile), { kind: 'ambiguous', code: SEND_OUTPUT_INCOMPLETE });
  });
});
