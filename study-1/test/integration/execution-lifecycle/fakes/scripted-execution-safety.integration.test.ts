// Conformance of the scripted execution safety: it answers as the real supervisor does for the
// states it scripts (no trial after the deadline or after active work ended; checks breach once
// their limit is passed).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ScriptedExecutionSafety } from './scripted-execution-safety.ts';

describe('ScriptedExecutionSafety', () => {
  it('lets trials start until the deadline is reached', () => {
    const safety = new ScriptedExecutionSafety();
    assert.equal(safety.mayStartTrial(), true);
    assert.equal(safety.activeDeadlineReached(), false);
    safety.reachDeadline();
    assert.equal(safety.mayStartTrial(), false);
    assert.equal(safety.activeDeadlineReached(), true);
    assert.equal(safety.checks()[0]?.result, 'breached');
  });

  it('refuses trials once active work ended, and counts the calls', () => {
    const safety = new ScriptedExecutionSafety();
    safety.markActiveEnded();
    safety.markActiveEnded();
    assert.equal(safety.mayStartTrial(), false);
    assert.equal(safety.activeEndedCalls(), 2);
  });

  it('reports a total-time breach once the target is exceeded', () => {
    const safety = new ScriptedExecutionSafety();
    assert.equal(safety.totalTargetExceeded(), false);
    assert.equal(safety.checks()[1]?.result, 'within_limits');
    safety.exceedTotal();
    assert.equal(safety.totalTargetExceeded(), true);
    assert.deepEqual(
      safety.checks().map((check) => [check.boundary, check.result]),
      [
        ['ACTIVE_TIME', 'within_limits'],
        ['TOTAL_TIME', 'breached'],
      ],
    );
  });
});
