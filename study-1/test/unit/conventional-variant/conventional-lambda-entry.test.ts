// The log line of a conventional delivery that did not complete (structured logging; Owner
// amendment A-05): the caller's own line for its faults and propagated failures, and a bounded,
// total description of anything else that was thrown.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ConventionalCallerFault,
  DeliveryFailurePropagated,
} from '../../../src/conventional-variant/conventional-fault.ts';
import { conventionalLogLine } from '../../../src/conventional-variant/conventional-lambda-entry.ts';
import { QUOTED_JSON_LIMIT } from '../../../src/record-contract/json-value.ts';

describe('conventionalLogLine', () => {
  it("writes a fault's and a propagated failure's own line, whatever request id the entry holds", () => {
    const fault = new ConventionalCallerFault('JOURNAL_STOPPED', 'req-fault', 'the journal stopped');
    const failure = new DeliveryFailurePropagated('req-failure', 'message-1', 2);
    assert.deepEqual(conventionalLogLine(fault, 'req-entry'), {
      level: 'error',
      event: 'conventional_caller_fault',
      code: 'JOURNAL_STOPPED',
      lambda_request_id: 'req-fault',
      detail: 'JOURNAL_STOPPED: the journal stopped',
    });
    assert.deepEqual(conventionalLogLine(failure, 'req-entry'), {
      level: 'warn',
      event: 'conventional_delivery_failed',
      lambda_request_id: 'req-failure',
      message_id: 'message-1',
      approximate_receive_count: 2,
    });
  });

  it('describes any other Error by its name and message under the request id', () => {
    assert.deepEqual(conventionalLogLine(new RangeError('provider_qualifier "$LATEST"'), 'req-1'), {
      level: 'error',
      event: 'conventional_caller_error',
      lambda_request_id: 'req-1',
      error_name: 'RangeError',
      detail: 'provider_qualifier "$LATEST"',
    });
  });

  it('bounds the name and the message of an Error, so a log line never grows with the error', () => {
    const error = new Error('m'.repeat(100_000));
    error.name = 'N'.repeat(100_000);
    const line = conventionalLogLine(error, 'req-1');
    assert.deepEqual(line, {
      level: 'error',
      event: 'conventional_caller_error',
      lambda_request_id: 'req-1',
      error_name: `${'N'.repeat(QUOTED_JSON_LIMIT)}…[truncated]`,
      detail: `${'m'.repeat(QUOTED_JSON_LIMIT)}…[truncated]`,
    });
  });

  it('names a thrown value that is no Error NonErrorThrown, without echoing it', () => {
    for (const thrown of ['secret text', undefined, null, 12, { message: 'not an error' }]) {
      assert.deepEqual(conventionalLogLine(thrown, 'req-1'), {
        level: 'error',
        event: 'conventional_caller_error',
        lambda_request_id: 'req-1',
        error_name: 'NonErrorThrown',
        detail: 'a thrown value that is not an Error instance',
      });
    }
  });
});
