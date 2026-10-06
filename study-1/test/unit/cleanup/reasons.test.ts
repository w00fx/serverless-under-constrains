// Reasons cleanup records: a thrown value becomes a structured reason (BR-RUA-046, cleanup never
// abandons its steps), every port reason is made schema-conforming before it is journaled (the
// AC-RUA-011 run-twice regression: an SDK error name as `code` made the line unreadable), and a
// step outcome follows its failures.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { conformingReason, upperSnakeCode } from '../../../src/cleanup/reason-conformance.ts';
import { outcomeFromFailures } from '../../../src/cleanup/step-recording.ts';
import { reasonFromThrown } from '../../../src/cleanup/thrown-reason.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';

describe('reasonFromThrown', () => {
  it('names an Error by its name and message', () => {
    assert.deepEqual(reasonFromThrown(new TypeError('socket hang up'), 'SURFACE_QUERY_THREW', 'functions'), {
      code: 'SURFACE_QUERY_THREW',
      subject: 'functions',
      detail: 'threw TypeError: socket hang up; expected a result value',
    });
  });

  it('bounds a long message and names a non-Error by its type', () => {
    const long = reasonFromThrown(new Error('x'.repeat(5_000)), 'C', 's');
    assert.ok(long.detail.length < 400, `detail of ${String(long.detail.length)} characters`);
    assert.equal(reasonFromThrown('text', 'C', 's').detail, 'threw a non-Error string; expected a result value');
    assert.equal(reasonFromThrown(undefined, 'C', 's').detail, 'threw a non-Error undefined; expected a result value');
  });
});

describe('upperSnakeCode', () => {
  it('keeps an UPPER_SNAKE code and converts other spellings', () => {
    assert.deepEqual(
      [
        'STACK_DELETE_FAILED',
        'ResourceInUseException',
        'ThrottlingException',
        'AWS.SimpleQueueService.NonExistentQueue',
        'socket hang-up',
        '404',
        '',
        'ÉÉ',
        '__a__',
      ].map(upperSnakeCode),
      [
        'STACK_DELETE_FAILED',
        'RESOURCE_IN_USE_EXCEPTION',
        'THROTTLING_EXCEPTION',
        'AWS_SIMPLE_QUEUE_SERVICE_NON_EXISTENT_QUEUE',
        'SOCKET_HANG_UP',
        'CODE_404',
        'CODE_UNNAMED',
        'CODE_UNNAMED',
        'A',
      ],
    );
  });
});

describe('conformingReason', () => {
  it('fixes the code, names empty fields and moves the artifact path into the detail', () => {
    assert.deepEqual(
      conformingReason({ code: 'AccessDenied', subject: '', detail: '', artifact_path: '../outside.json' }),
      { code: 'ACCESS_DENIED', subject: '(empty)', detail: '(empty) (artifact ../outside.json)' },
    );
  });

  it('keeps a UUIDv4 event id and drops any other', () => {
    const eventId = '3f1c2a9e-8b4d-4c1e-9f00-1a2b3c4d5e6f' as Uuid4;
    assert.deepEqual(conformingReason({ code: 'C', subject: 's', detail: 'd', event_id: eventId }), {
      code: 'C',
      subject: 's',
      detail: 'd',
      event_id: eventId,
    });
    assert.deepEqual(conformingReason({ code: 'C', subject: 's', detail: 'd', event_id: 'not-a-uuid' as Uuid4 }), {
      code: 'C',
      subject: 's',
      detail: 'd',
    });
  });
});

describe('outcomeFromFailures', () => {
  it('succeeds without failures and fails with them', () => {
    const reason = { code: 'C', subject: 's', detail: 'd' };
    assert.deepEqual(outcomeFromFailures([]), { status: 'succeeded', reasons: [] });
    assert.deepEqual(outcomeFromFailures([reason]), { status: 'failed', reasons: [reason] });
  });
});
