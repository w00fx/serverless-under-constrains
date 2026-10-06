// Property targets `classifySendFailure` and `sentOutcomeOf` (BR-RUA-020, D-29, Owner amendment
// A-05, design §12.5): what a single-attempt SQS SendMessage or Lambda Invoke threw, or returned,
// is untrusted. Over arbitrary thrown values and outputs, including throwing getters, throwing
// proxies and inherited members, both are total and bounded, and agree with a reference model
// written from the classifier's rule: `rejected` exactly for an Error that owns `$fault: 'client'`
// and an own `$metadata` owning an integer `httpStatusCode` in 400..499; `sent` exactly for an
// output owning a non-empty MessageId, SequenceNumber and MD5OfMessageBody.

import { describe, it } from 'node:test';

import fc from 'fast-check';

import { QUOTED_JSON_LIMIT } from '../../../src/record-contract/json-value.ts';
import {
  classifySendFailure,
  FAILURE_CODE_LIMIT,
  SEND_OUTPUT_INCOMPLETE,
  sentOutcomeOf,
} from '../../../src/trial-execution/send-failure-classification.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { anyValue, inheriting, throwingMember, throwingProxy, withThrowingMember } from './support/hostile-values.ts';

const MARKER = '…[truncated]';
const CODE_BOUND = FAILURE_CODE_LIMIT + MARKER.length;
const DETAIL_BOUND = CODE_BOUND + QUOTED_JSON_LIMIT + MARKER.length + 80;

/** A thrown value and whether the reference model calls it a definitive rejection. */
interface Thrown {
  readonly value: unknown;
  readonly rejected: boolean;
}

// Weighted towards a definitive rejection, so every run exercises both answers of the rule.
const statuses: fc.Arbitrary<unknown> = fc.oneof(
  { arbitrary: fc.integer({ min: 400, max: 499 }), weight: 4 },
  fc.integer({ min: -1000, max: 1000 }),
  fc.double(),
  fc.integer({ min: 400, max: 499 }).map(String),
  anyValue,
);

const isClientStatus = (status: unknown): boolean =>
  typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 499;

const serviceExceptions: fc.Arbitrary<Thrown> = fc
  .record({
    name: fc.oneof(fc.string({ maxLength: 300 }), anyValue),
    message: fc.oneof(fc.string({ maxLength: 1000 }), anyValue),
    fault: fc.oneof({ arbitrary: fc.constant<unknown>('client'), weight: 4 }, fc.constant<unknown>('server'), anyValue),
    status: statuses,
    shape: fc.oneof(
      { arbitrary: fc.constant('own'), weight: 4 },
      fc.constantFrom('inherited_fault', 'inherited_status', 'metadata_not_object', 'throwing_metadata'),
    ),
  })
  .map(({ name, message, fault, status, shape }) => {
    const error = new Error();
    Object.defineProperty(error, 'name', { value: name, enumerable: true });
    Object.defineProperty(error, 'message', { value: message, enumerable: true });
    const metadata: Record<string, unknown> = {
      own: { httpStatusCode: status },
      inherited_fault: { httpStatusCode: status },
      inherited_status: inheriting({ httpStatusCode: status }),
      metadata_not_object: status,
      throwing_metadata: throwingMember('httpStatusCode'),
    };
    if (shape === 'inherited_fault') {
      Object.setPrototypeOf(error, inheriting({ $fault: fault }));
    } else {
      Object.defineProperty(error, '$fault', { value: fault, enumerable: true });
    }
    Object.defineProperty(error, '$metadata', { value: metadata[shape], enumerable: true });
    // `inherited_fault` drops Error from the prototype chain, so it is not an Error at all.
    const rejected = shape === 'own' && fault === 'client' && isClientStatus(status);
    return { value: error, rejected };
  });

const thrownValues: fc.Arbitrary<Thrown> = fc.oneof(
  { arbitrary: serviceExceptions, weight: 3 },
  anyValue.map((value) => ({ value, rejected: false })),
  fc.constant({ value: throwingProxy(new Error('proxied')), rejected: false }),
  fc.constant({
    value: withThrowingMember(new Error('getter'), '$fault'),
    rejected: false,
  }),
);

/** A SendMessage output and whether the reference model calls it sent. */
interface Output {
  readonly value: unknown;
  readonly sent: boolean;
}

const MEMBERS = ['MessageId', 'SequenceNumber', 'MD5OfMessageBody'] as const;
const memberValue: fc.Arbitrary<unknown> = fc.oneof(
  { arbitrary: fc.string({ minLength: 1, maxLength: 40 }), weight: 6 },
  fc.string({ maxLength: 1 }),
  anyValue,
);

const outputs: fc.Arbitrary<Output> = fc.oneof(
  fc.tuple(memberValue, memberValue, memberValue, fc.boolean()).map(([messageId, sequence, md5, inherited]) => {
    const members = { MessageId: messageId, SequenceNumber: sequence, MD5OfMessageBody: md5 };
    const sent = !inherited && [messageId, sequence, md5].every((value) => typeof value === 'string' && value !== '');
    return { value: inherited ? inheriting(members) : members, sent };
  }),
  fc.constantFrom(...MEMBERS).map((member) => ({
    value: withThrowingMember({ MessageId: 'm', SequenceNumber: '1', MD5OfMessageBody: 'd' }, member),
    sent: false,
  })),
  fc.constant({ value: throwingProxy({ MessageId: 'm', SequenceNumber: '1', MD5OfMessageBody: 'd' }), sent: false }),
  anyValue.map((value) => ({ value, sent: false })),
);

describe('classifySendFailure properties', () => {
  it('rejects exactly what the reference model rejects, with a bounded code and detail', () => {
    fc.assert(
      fc.property(thrownValues, ({ value, rejected }) => {
        const failure = classifySendFailure(value);
        return (
          failure.kind === (rejected ? 'rejected' : 'ambiguous') &&
          failure.code.length <= CODE_BOUND &&
          failure.detail.length <= DETAIL_BOUND
        );
      }),
      fuzzParameters(),
    );
  });
});

describe('sentOutcomeOf properties', () => {
  it('is sent exactly when the reference model says so, and ambiguous otherwise', () => {
    fc.assert(
      fc.property(outputs, ({ value, sent }) => {
        const outcome = sentOutcomeOf(value);
        return sent ? outcome.kind === 'sent' : outcome.kind === 'ambiguous' && outcome.code === SEND_OUTPUT_INCOMPLETE;
      }),
      fuzzParameters(),
    );
  });
});
