// What a settled SDK call means for each cleanup port (design §10.4, AC-RUA-011): "not found" is
// an absent resource, any other failure a reason coded by the error name, malformed output a
// failure naming the member; paging of one resource reads `gone` when any page says so.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SdkCallResult } from '../../../src/cleanup/sdk-call-outcomes.ts';
import {
  consumerStateOutcome,
  described,
  describedPages,
  deletionOutcome,
  disableRequestOutcome,
  dlqChangeOutcome,
  dlqReceiveOutcome,
  durableStopOutcome,
  itemsOrNone,
  nothingFound,
  observedTags,
  presenceOf,
  readingsOfEach,
  settleCleanupCall,
  sightingWithTags,
  stackDeleteOutcome,
  stackReadOutcome,
  stopNeedsStatusRead,
  surfaceAnswer,
} from '../../../src/cleanup/sdk-call-outcomes.ts';
import { MALFORMED_OUTPUT, requiredText } from '../../../src/cleanup/surface-readings.ts';
import type { Page, Reading } from '../../../src/cleanup/surface-readings.ts';
import { tableTagsPage } from '../../../src/cleanup/surface-readings-services.ts';
import { err, ok } from '../../../src/record-contract/primitives.ts';
import { STACK_ID } from '../../support/cleanup/cleanup-fixtures.ts';

const NOT_FOUND: SdkCallResult = err({ name: 'ResourceNotFoundException', message: 'no such thing' });
const THROTTLED: SdkCallResult = err({ name: 'ThrottlingException', message: 'slow down' });
const REASON = { code: 'C', subject: 's', detail: 'd' };

function throttledReason(subject: string, expected: string): { code: string; subject: string; detail: string } {
  return { code: 'THROTTLING_EXCEPTION', subject, detail: `ThrottlingException: slow down; expected ${expected}` };
}

describe('settleCleanupCall', () => {
  it('settles an answer and a throw without throwing', async () => {
    assert.deepEqual(await settleCleanupCall(() => Promise.resolve({ a: 1 })), ok({ a: 1 }));
    const thrown = Object.assign(new Error('gone'), { name: 'QueueDoesNotExist' });
    assert.deepEqual(
      await settleCleanupCall(() => Promise.reject(thrown)),
      err({ name: 'QueueDoesNotExist', message: 'gone' }),
    );
  });
});

describe('described', () => {
  const readName = (output: unknown): Reading<string> => requiredText(output, 'Name', 'Op');

  it('reads found output, a not-found failure as gone and any other failure as failed', () => {
    assert.deepEqual(described(ok({ Name: 'n' }), readName, 'subj', 'a name'), { kind: 'found', value: 'n' });
    assert.deepEqual(described(NOT_FOUND, readName, 'subj', 'a name'), { kind: 'gone' });
    assert.deepEqual(described(THROTTLED, readName, 'subj', 'a name'), {
      kind: 'failed',
      reason: throttledReason('subj', 'a name'),
    });
  });

  it('fails on output that does not read', () => {
    assert.deepEqual(described(ok({}), readName, 'subj', 'a name'), {
      kind: 'failed',
      reason: { code: MALFORMED_OUTPUT, subject: 'Op', detail: 'Name is absent; expected a non-empty string' },
    });
  });
});

describe('describedPages', () => {
  function scripted(...answers: SdkCallResult[]): (cursor: string | undefined) => Promise<SdkCallResult> {
    return () => Promise.resolve(answers.shift() ?? ok({}));
  }

  it('joins every page of one resource', async () => {
    const listing = await describedPages(
      scripted(ok({ Tags: [{ Key: 'a', Value: '1' }], NextToken: 'n' }), ok({ Tags: [{ Key: 'b', Value: '2' }] })),
      tableTagsPage,
      'arn',
      'the tags',
    );
    assert.deepEqual(listing, {
      kind: 'found',
      value: [
        { key: 'a', value: '1' },
        { key: 'b', value: '2' },
      ],
    });
  });

  it('reads gone when a later page says the resource does not exist', async () => {
    const listing = await describedPages(
      scripted(ok({ Tags: [], NextToken: 'n' }), NOT_FOUND),
      tableTagsPage,
      'arn',
      'x',
    );
    assert.deepEqual(listing, { kind: 'gone' });
  });

  it('fails on a failed page and on a paging failure', async () => {
    assert.deepEqual(await describedPages(scripted(THROTTLED), tableTagsPage, 'arn', 'the tags'), {
      kind: 'failed',
      reason: throttledReason('arn', 'the tags'),
    });
    const looping = await describedPages(
      () => Promise.resolve(ok({ Tags: [], NextToken: 'same' })),
      tableTagsPage,
      'arn',
      'the tags',
    );
    assert.equal(looping.kind === 'failed' && looping.reason.code, 'PAGINATION_CURSOR_REPEATED');
  });

  it('is found after a failed page only if no page was gone', async () => {
    const readPage = (output: unknown): Reading<Page<number>> =>
      output === 'x' ? ok({ items: [1] }) : ok({ items: [] });
    assert.deepEqual(await describedPages(scripted(ok('x')), readPage, 's', 'e'), { kind: 'found', value: [1] });
  });
});

describe('listing helpers', () => {
  it('reads items, none for a gone subject, and the failure of a failed one', () => {
    assert.deepEqual(itemsOrNone({ kind: 'found', value: [1] }), ok([1]));
    assert.deepEqual(itemsOrNone({ kind: 'gone' }), ok([]));
    assert.deepEqual(itemsOrNone({ kind: 'failed', reason: REASON }), err(REASON));
    assert.deepEqual(nothingFound({ kind: 'gone' }), ok([]));
    assert.deepEqual(nothingFound({ kind: 'failed', reason: REASON }), err(REASON));
  });

  it('joins readings in order and stops at the first failure', async () => {
    const seen: number[] = [];
    const joined = await readingsOfEach([1, 2, 3], (item) => {
      seen.push(item);
      return Promise.resolve(item === 2 ? err(REASON) : ok([item]));
    });
    assert.deepEqual(joined, err(REASON));
    assert.deepEqual(seen, [1, 2]);
    assert.deepEqual(await readingsOfEach([1, 2], (item) => Promise.resolve(ok([item, item]))), ok([1, 1, 2, 2]));
  });

  it('observes tags as tagged, unknown on a failed read, and nothing for a gone resource', () => {
    assert.deepEqual(observedTags({ kind: 'found', value: [] }), { kind: 'tagged', tags: [] });
    assert.deepEqual(observedTags({ kind: 'failed', reason: REASON }), { kind: 'unknown', reason: REASON });
    assert.equal(observedTags({ kind: 'gone' }), undefined);
    const sighted = { resource_type: 'T', identifier: 'i', surface: 'queues' as const };
    assert.deepEqual(sightingWithTags(sighted, { kind: 'found', value: [] }), [
      { ...sighted, tags: { kind: 'tagged', tags: [] } },
    ]);
    assert.deepEqual(sightingWithTags(sighted, { kind: 'gone' }), []);
  });

  it('answers a surface query and a presence check', () => {
    assert.deepEqual(surfaceAnswer(ok([])), { ok: true, resources: [] });
    assert.deepEqual(surfaceAnswer(err(REASON)), { ok: false, reason: REASON });
    assert.deepEqual(presenceOf({ kind: 'found', value: true }), { kind: 'present' });
    assert.deepEqual(presenceOf({ kind: 'found', value: false }), { kind: 'absent' });
    assert.deepEqual(presenceOf({ kind: 'gone' }), { kind: 'absent' });
    assert.deepEqual(presenceOf({ kind: 'failed', reason: REASON }), { kind: 'failed', reason: REASON });
  });
});

describe('consumer control outcomes', () => {
  it('reads a disable request as requested, absent or failed', () => {
    assert.deepEqual(disableRequestOutcome(ok({ State: 'Disabling' }), 'u'), { kind: 'requested' });
    assert.deepEqual(disableRequestOutcome(NOT_FOUND, 'u'), { kind: 'absent' });
    assert.deepEqual(disableRequestOutcome(THROTTLED, 'u'), {
      kind: 'failed',
      reason: throttledReason('u', 'the mapping disable to be accepted'),
    });
  });

  it('reads a mapping state, absent or failed', () => {
    assert.deepEqual(consumerStateOutcome(ok({ UUID: 'u', State: 'Disabled' }), 'u'), {
      kind: 'state',
      state: 'Disabled',
    });
    assert.deepEqual(consumerStateOutcome(NOT_FOUND, 'u'), { kind: 'absent' });
    assert.deepEqual(consumerStateOutcome(THROTTLED, 'u'), {
      kind: 'failed',
      reason: throttledReason('u', 'the mapping state'),
    });
    assert.equal(consumerStateOutcome(ok({ UUID: 'u' }), 'u').kind, 'failed');
  });
});

describe('stack outcomes', () => {
  const described_ = (status: string): SdkCallResult => ok({ Stacks: [{ StackId: STACK_ID, StackStatus: status }] });

  it('reads a present stack, and absent for does-not-exist, no stack or DELETE_COMPLETE', () => {
    assert.deepEqual(stackReadOutcome(described_('DELETE_IN_PROGRESS'), STACK_ID), {
      kind: 'present',
      status: 'DELETE_IN_PROGRESS',
    });
    assert.deepEqual(stackReadOutcome(described_('DELETE_COMPLETE'), STACK_ID), { kind: 'absent' });
    assert.deepEqual(stackReadOutcome(ok({ Stacks: [] }), STACK_ID), { kind: 'absent' });
    const missing = err({ name: 'ValidationError', message: `Stack with id ${STACK_ID} does not exist` });
    assert.deepEqual(stackReadOutcome(missing, STACK_ID), { kind: 'absent' });
    assert.deepEqual(stackReadOutcome(THROTTLED, STACK_ID), {
      kind: 'failed',
      reason: throttledReason(STACK_ID, 'the stack description'),
    });
  });

  it('reads a delete request as requested or failed', () => {
    assert.deepEqual(stackDeleteOutcome(ok({}), STACK_ID), { kind: 'requested' });
    assert.deepEqual(stackDeleteOutcome(THROTTLED, STACK_ID), {
      kind: 'failed',
      reason: throttledReason(STACK_ID, 'the stack deletion to be accepted'),
    });
  });
});

describe('deletionOutcome', () => {
  it('reads deleted, already absent (AC-RUA-011) and failed, a conflict included', () => {
    assert.deepEqual(deletionOutcome(ok({}), 'r'), { kind: 'deleted' });
    assert.deepEqual(deletionOutcome(err({ name: 'NoSuchEntityException', message: '' }), 'r'), {
      kind: 'already_absent',
    });
    assert.deepEqual(deletionOutcome(err({ name: 'DeleteConflictException', message: 'policies attached' }), 'r'), {
      kind: 'failed',
      reason: {
        code: 'DELETE_CONFLICT_EXCEPTION',
        subject: 'r',
        detail: 'DeleteConflictException: policies attached; expected the resource to be deleted',
      },
    });
  });
});

describe('durable stop outcomes', () => {
  const REFUSED: SdkCallResult = err({ name: 'InvalidParameterValueException', message: 'not running' });
  const ARN = 'arn:aws:lambda:us-east-1:1:function:f:3/durable-execution/e/1';

  it('reads a stop as stopped, and a not-found stop as not running without a status read', () => {
    assert.deepEqual(durableStopOutcome(ok({}), undefined, ARN), { kind: 'stopped' });
    assert.equal(stopNeedsStatusRead(ok({})), false);
    assert.equal(stopNeedsStatusRead(NOT_FOUND), false);
    assert.deepEqual(durableStopOutcome(NOT_FOUND, undefined, ARN), { kind: 'not_running' });
  });

  it('reads a refused stop by the execution status read after it', () => {
    assert.equal(stopNeedsStatusRead(REFUSED), true);
    assert.deepEqual(durableStopOutcome(REFUSED, { kind: 'found', value: 'SUCCEEDED' }, ARN), { kind: 'not_running' });
    assert.deepEqual(durableStopOutcome(REFUSED, { kind: 'gone' }, ARN), { kind: 'not_running' });
    const failed = {
      kind: 'failed',
      reason: {
        code: 'INVALID_PARAMETER_VALUE_EXCEPTION',
        subject: ARN,
        detail: 'InvalidParameterValueException: not running; expected the running execution to stop',
      },
    };
    assert.deepEqual(durableStopOutcome(REFUSED, { kind: 'found', value: 'RUNNING' }, ARN), failed);
    assert.deepEqual(durableStopOutcome(REFUSED, { kind: 'failed', reason: REASON }, ARN), failed);
    assert.deepEqual(durableStopOutcome(REFUSED, undefined, ARN), failed);
  });
});

describe('DLQ outcomes', () => {
  const URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/q';

  it('reads a receive as messages, an absent queue or a failure', () => {
    assert.deepEqual(dlqReceiveOutcome(ok({ Messages: [{ MessageId: 'm', ReceiptHandle: 'r' }] }), URL), {
      kind: 'messages',
      messages: [{ message_id: 'm', receipt_handle: 'r' }],
    });
    assert.deepEqual(dlqReceiveOutcome(ok({}), URL), { kind: 'messages', messages: [] });
    assert.deepEqual(dlqReceiveOutcome(err({ name: 'QueueDoesNotExist', message: '' }), URL), { kind: 'queue_absent' });
    assert.deepEqual(dlqReceiveOutcome(THROTTLED, URL), {
      kind: 'failed',
      reason: throttledReason(URL, 'a receive of the dead-letter queue'),
    });
  });

  it('reads a delete or release as done or failed', () => {
    assert.deepEqual(dlqChangeOutcome(ok({}), URL, 'x'), { kind: 'done' });
    assert.deepEqual(dlqChangeOutcome(THROTTLED, URL, 'the message to be released'), {
      kind: 'failed',
      reason: throttledReason(URL, 'the message to be released'),
    });
  });
});
