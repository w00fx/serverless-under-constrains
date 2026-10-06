// ProviderFault: a thrown operational fault (a Lambda function error), never a business
// response; its structured JSON log line carries the code, the commit phase and the call id.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PROVIDER_FAULT_CODES,
  ProviderFault,
  unexpectedErrorLog,
} from '../../../src/refund-provider/provider-fault.ts';
import { ATTEMPT_ID } from './support/provider-fixtures.ts';

describe('ProviderFault', () => {
  it('carries its code, phase and call id, and prefixes the message with the code', () => {
    const fault = new ProviderFault(
      'COMMIT_AMBIGUOUS',
      'commit_unknown',
      ATTEMPT_ID,
      'outcome TimeoutError; expected applied',
    );
    assert.ok(fault instanceof Error);
    assert.equal(fault.name, 'ProviderFault');
    assert.equal(fault.code, 'COMMIT_AMBIGUOUS');
    assert.equal(fault.phase, 'commit_unknown');
    assert.equal(fault.providerCallId, ATTEMPT_ID);
    assert.equal(fault.message, 'COMMIT_AMBIGUOUS: outcome TimeoutError; expected applied');
  });

  it('renders one structured log line, with null for an unknown call id', () => {
    assert.deepEqual(new ProviderFault('UNATTRIBUTABLE_CALL', 'before_commit', undefined, 'no trial').toLog(), {
      level: 'error',
      event: 'provider_fault',
      code: 'UNATTRIBUTABLE_CALL',
      phase: 'before_commit',
      provider_call_id: null,
      detail: 'UNATTRIBUTABLE_CALL: no trial',
    });
    assert.equal(
      new ProviderFault('COMMIT_FAILED', 'after_commit', ATTEMPT_ID, 'x').toLog().provider_call_id,
      ATTEMPT_ID,
    );
  });

  it('closes the fault vocabulary', () => {
    assert.deepEqual(PROVIDER_FAULT_CODES, [
      'UNATTRIBUTABLE_CALL',
      'CONFIGURATION_MISSING',
      'STATE_UNREADABLE',
      'JOURNAL_STOPPED',
      'COMMIT_FAILED',
      'COMMIT_AMBIGUOUS',
      'TREATMENT_UNEXPECTED',
      'TRANSITION_AMBIGUOUS',
      'WARMUP_REQUEST_INVALID',
    ]);
  });

  it('renders any other escaping error as one structured line, naming a thrown non-Error by type', () => {
    assert.deepEqual(unexpectedErrorLog(new RangeError('Maximum call stack size exceeded')), {
      level: 'error',
      event: 'provider_unexpected_error',
      error_name: 'RangeError',
      detail: 'Maximum call stack size exceeded',
    });
    assert.deepEqual(unexpectedErrorLog('boom'), {
      level: 'error',
      event: 'provider_unexpected_error',
      error_name: 'string',
      detail: 'a thrown value that is not an Error',
    });
  });
});
