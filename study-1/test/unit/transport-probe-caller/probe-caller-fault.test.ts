// The probe caller's faults and their structured log line.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PROBE_CALLER_FAULT_CODES, ProbeCallerFault } from '../../../src/transport-probe-caller/probe-caller-fault.ts';

describe('ProbeCallerFault', () => {
  it('carries its code, request id and detail, and logs them as one JSON object', () => {
    const fault = new ProbeCallerFault(
      'JOURNAL_STOPPED',
      'req-1',
      'caller_invocation_started not written: AMBIGUOUS_APPEND',
    );
    assert.ok(fault instanceof Error);
    assert.equal(fault.name, 'ProbeCallerFault');
    assert.equal(fault.code, 'JOURNAL_STOPPED');
    assert.equal(fault.lambdaRequestId, 'req-1');
    assert.deepEqual(fault.toLog(), {
      level: 'error',
      event: 'probe_caller_fault',
      code: 'JOURNAL_STOPPED',
      lambda_request_id: 'req-1',
      detail: 'JOURNAL_STOPPED: caller_invocation_started not written: AMBIGUOUS_APPEND',
    });
  });

  it('has a closed code vocabulary', () => {
    assert.deepEqual(PROBE_CALLER_FAULT_CODES, ['REQUEST_INVALID', 'JOURNAL_STOPPED']);
  });
});
