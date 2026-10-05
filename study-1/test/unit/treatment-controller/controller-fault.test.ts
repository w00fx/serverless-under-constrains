// The controller's operational faults and their structured log line.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONTROLLER_FAULT_CODES, ControllerFault } from '../../../src/treatment-controller/controller-fault.ts';
import { PROBE_PK } from './support/controller-fixtures.ts';

describe('ControllerFault', () => {
  it('carries its code, partition and detail, and logs them as one JSON object', () => {
    const fault = new ControllerFault(
      'SIGNAL_AMBIGUOUS',
      PROBE_PK,
      'signal transaction AMBIGUOUS_APPEND; expected applied',
    );
    assert.ok(fault instanceof Error);
    assert.equal(fault.name, 'ControllerFault');
    assert.equal(fault.code, 'SIGNAL_AMBIGUOUS');
    assert.equal(fault.partitionKey, PROBE_PK);
    assert.equal(fault.message, 'SIGNAL_AMBIGUOUS: signal transaction AMBIGUOUS_APPEND; expected applied');
    assert.deepEqual(fault.toLog(), {
      level: 'error',
      event: 'controller_fault',
      code: 'SIGNAL_AMBIGUOUS',
      partition_key: PROBE_PK,
      detail: 'SIGNAL_AMBIGUOUS: signal transaction AMBIGUOUS_APPEND; expected applied',
    });
  });

  it('has a closed code vocabulary', () => {
    assert.deepEqual(CONTROLLER_FAULT_CODES, [
      'STATE_UNREADABLE',
      'JOURNAL_STOPPED',
      'SIGNAL_AMBIGUOUS',
      'SIGNAL_FAILED',
      'SIGNAL_REDECIDED_TO_SIGNAL',
    ]);
  });
});
