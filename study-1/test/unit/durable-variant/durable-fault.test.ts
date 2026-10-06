// What a Durable step attempt throws and logs: a StepAttemptFailed for a failed provider attempt
// (the SDK retries the step), and a DurableCallerFault when the caller cannot work with complete
// evidence. Both carry a structured JSON log line (clean-code logging rule).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DURABLE_FAULT_CODES,
  DurableCallerFault,
  STEP_ATTEMPT_FAILED_ERROR_NAME,
  StepAttemptFailed,
} from '../../../src/durable-variant/durable-fault.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';

const ATTEMPT_ID = 'dddddddd-0000-4000-8000-000000000003' as Uuid4;
const ARN = 'arn:aws:lambda:us-east-1:123456789012:function:caller:4/durable-execution/n/i';

describe('DurableCallerFault', () => {
  it('lists the fault codes', () => {
    assert.deepEqual(DURABLE_FAULT_CODES, [
      'DELIVERY_INVALID',
      'REGISTRY_UNREADABLE',
      'NO_ACTIVE_TRIAL',
      'REGISTRATION_MISMATCH',
      'JOURNAL_STOPPED',
      'ATTEMPT_NOT_REGISTERED',
      'STATE_NOT_RECORDED',
    ]);
  });

  it('carries its code, request id and detail, and logs them as one error line', () => {
    const fault = new DurableCallerFault('NO_ACTIVE_TRIAL', 'req-1', 'no registry item');
    assert.ok(fault instanceof Error);
    assert.equal(fault.name, 'DurableCallerFault');
    assert.equal(fault.message, 'NO_ACTIVE_TRIAL: no registry item');
    assert.equal(fault.code, 'NO_ACTIVE_TRIAL');
    assert.equal(fault.lambdaRequestId, 'req-1');
    assert.deepEqual(fault.toLog(), {
      level: 'error',
      event: 'durable_caller_fault',
      code: 'NO_ACTIVE_TRIAL',
      lambda_request_id: 'req-1',
      detail: 'NO_ACTIVE_TRIAL: no registry item',
    });
  });
});

describe('StepAttemptFailed', () => {
  it('names the failed step attempt and logs it as one warn line', () => {
    const failed = {
      lambda_request_id: 'req-2',
      durable_execution_arn: ARN,
      step_attempt: 1,
      attempt_id: ATTEMPT_ID,
      outcome_class: 'AMBIGUOUS',
    } as const;
    const failure = new StepAttemptFailed(failed);
    assert.ok(failure instanceof Error);
    assert.equal(STEP_ATTEMPT_FAILED_ERROR_NAME, 'StepAttemptFailed');
    assert.equal(failure.name, 'StepAttemptFailed');
    assert.equal(
      failure.message,
      `step attempt 1 of ${ARN} ended AMBIGUOUS (attempt ${ATTEMPT_ID}); the step retry strategy decides what follows`,
    );
    assert.deepEqual(failure.failed, failed);
    assert.deepEqual(failure.toLog(), { level: 'warn', event: 'durable_step_attempt_failed', ...failed });
  });
});
