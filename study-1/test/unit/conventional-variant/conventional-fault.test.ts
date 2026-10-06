// The structured log lines of what the conventional caller throws (clean-code logging rule):
// a fault before or after the attempt, and the propagated delivery failure that makes SQS
// redeliver (BR-RUA-020).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONVENTIONAL_FAULT_CODES,
  ConventionalCallerFault,
  DeliveryFailurePropagated,
} from '../../../src/conventional-variant/conventional-fault.ts';

describe('ConventionalCallerFault', () => {
  it('carries its code and request id, and logs one structured line', () => {
    const fault = new ConventionalCallerFault('NO_ACTIVE_TRIAL', 'req-1', 'no registry item');
    assert.equal(fault.name, 'ConventionalCallerFault');
    assert.equal(fault.message, 'NO_ACTIVE_TRIAL: no registry item');
    assert.equal(fault.code, 'NO_ACTIVE_TRIAL');
    assert.equal(fault.lambdaRequestId, 'req-1');
    assert.ok(fault instanceof Error);
    assert.deepEqual(fault.toLog(), {
      level: 'error',
      event: 'conventional_caller_fault',
      code: 'NO_ACTIVE_TRIAL',
      lambda_request_id: 'req-1',
      detail: 'NO_ACTIVE_TRIAL: no registry item',
    });
  });

  it('has a closed code list', () => {
    assert.deepEqual(CONVENTIONAL_FAULT_CODES, [
      'DELIVERY_INVALID',
      'REGISTRY_UNREADABLE',
      'NO_ACTIVE_TRIAL',
      'REGISTRATION_MISMATCH',
      'JOURNAL_STOPPED',
      'ATTEMPT_NOT_REGISTERED',
      'STATE_NOT_RECORDED',
    ]);
  });
});

describe('DeliveryFailurePropagated', () => {
  it('is named for the event source mapping and logs the delivery it fails', () => {
    const failure = new DeliveryFailurePropagated('req-2', 'msg-1', 1);
    assert.equal(failure.name, 'DeliveryFailurePropagated');
    assert.equal(
      failure.message,
      'delivery msg-1 (receive 1) failed; the message returns after the visibility timeout',
    );
    assert.deepEqual(
      { request: failure.lambdaRequestId, message: failure.messageId, receive: failure.approximateReceiveCount },
      { request: 'req-2', message: 'msg-1', receive: 1 },
    );
    assert.deepEqual(failure.toLog(), {
      level: 'warn',
      event: 'conventional_delivery_failed',
      lambda_request_id: 'req-2',
      message_id: 'msg-1',
      approximate_receive_count: 1,
    });
  });
});
