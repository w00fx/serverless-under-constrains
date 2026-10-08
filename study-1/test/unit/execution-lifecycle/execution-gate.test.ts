// The execution's publication gate (design §5.3, §10.2; BR-RUA-045, BR-RUA-046; AC-RUA-049): the
// first interruption latches, the deadline latches itself when first seen, and nothing starts or
// publishes after it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ExecutionGate } from '../../../src/execution-lifecycle/execution-gate.ts';
import { ScriptedExecutionLease } from '../../integration/execution-lifecycle/fakes/scripted-execution-lease.ts';
import { ScriptedExecutionSafety } from '../../integration/execution-lifecycle/fakes/scripted-execution-safety.ts';

describe('ExecutionGate', () => {
  it('starts no trial until it is armed', () => {
    const gate = new ExecutionGate(new ScriptedExecutionLease());
    assert.equal(gate.mayStartTrial(), false);
    gate.arm(new ScriptedExecutionSafety());
    assert.equal(gate.mayStartTrial(), true);
    assert.equal(gate.interruption(), undefined);
  });

  it('keeps the first interruption and reports later ones as not latched', () => {
    const gate = new ExecutionGate(new ScriptedExecutionLease());
    gate.arm(new ScriptedExecutionSafety());
    assert.equal(gate.interrupt({ cause: 'LEASE_LOST', detail: 'ownership mismatch' }), true);
    assert.equal(gate.interrupt({ cause: 'OPERATOR_ABORT', detail: 'SIGINT' }), false);
    assert.deepEqual(gate.interruption(), { cause: 'LEASE_LOST', detail: 'ownership mismatch' });
    assert.equal(gate.mayStartTrial(), false);
    assert.equal(gate.publicationAllowed(), false);
  });

  it('answers the first SIGINT with interrupting and every later one with already_interrupted', () => {
    const gate = new ExecutionGate(new ScriptedExecutionLease());
    assert.equal(gate.abort('SIGINT'), 'interrupting');
    assert.equal(gate.abort('SIGINT'), 'already_interrupted');
    assert.deepEqual(gate.latched(), { cause: 'OPERATOR_ABORT', detail: 'SIGINT' });
  });

  it('latches SAFETY_DEADLINE the first time the deadline is seen, and keeps it', () => {
    const safety = new ScriptedExecutionSafety();
    const gate = new ExecutionGate(new ScriptedExecutionLease());
    gate.arm(safety);
    safety.reachDeadline();
    assert.equal(gate.latched(), undefined, 'latched() does not consult the deadline');
    assert.equal(gate.publicationAllowed(), false);
    assert.equal(gate.latched()?.cause, 'SAFETY_DEADLINE');
    assert.equal(gate.abort('SIGINT'), 'already_interrupted');
    assert.match(gate.interruption()?.detail ?? '', /active-time deadline was reached/);
  });

  it('does not publish without the lease, even when nothing interrupted', () => {
    const lease = new ScriptedExecutionLease();
    const gate = new ExecutionGate(lease);
    gate.arm(new ScriptedExecutionSafety());
    assert.equal(gate.publicationAllowed(), true);
    lease.lose();
    assert.equal(gate.publicationAllowed(), false);
    assert.equal(gate.interruption(), undefined);
  });

  it('starts no trial once the supervisor refuses one, without latching an interruption', () => {
    const safety = new ScriptedExecutionSafety();
    const gate = new ExecutionGate(new ScriptedExecutionLease());
    gate.arm(safety);
    safety.markActiveEnded();
    assert.equal(gate.mayStartTrial(), false);
    assert.equal(gate.interruption(), undefined);
  });
});
