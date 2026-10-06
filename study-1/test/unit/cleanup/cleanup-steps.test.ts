// The twelve BR-RUA-048 steps: the order of each mode (BR-RUA-049 stops consumers first), which
// steps a re-run repeats (AC-RUA-011), and the step-number guard.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CLEANUP_STEPS,
  cleanupStepOrder,
  isCleanupStep,
  mustRunStep,
  STEP_ACTIONS,
} from '../../../src/cleanup/cleanup-steps.ts';

describe('cleanupStepOrder', () => {
  it('runs the steps in number order in normal cleanup', () => {
    assert.deepEqual(cleanupStepOrder('NORMAL'), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('disables consumers first in emergency cleanup and keeps every step once', () => {
    const order = cleanupStepOrder('EMERGENCY');
    assert.deepEqual(order, [3, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      [...CLEANUP_STEPS],
    );
  });

  it('stops durable executions (5) before deleting the stack (9) in both modes (RK-10)', () => {
    for (const mode of ['NORMAL', 'EMERGENCY'] as const) {
      const order = cleanupStepOrder(mode);
      assert.ok(order.indexOf(5) < order.indexOf(9));
    }
  });
});

describe('mustRunStep', () => {
  it('skips a step that already succeeded, except the audit and freeze steps', () => {
    const succeeded = new Set<number>(CLEANUP_STEPS);
    assert.deepEqual(
      CLEANUP_STEPS.filter((step) => mustRunStep(step, succeeded)),
      [10, 11, 12],
    );
    assert.deepEqual(
      CLEANUP_STEPS.filter((step) => mustRunStep(step, new Set())),
      [...CLEANUP_STEPS],
    );
  });
});

describe('isCleanupStep and STEP_ACTIONS', () => {
  it('accepts 1 to 12 only', () => {
    assert.deepEqual(
      [0, 1, 12, 13, 1.5, -1].map((step) => isCleanupStep(step)),
      [false, true, true, false, false, false],
    );
  });

  it('names every step with a distinct UPPER_SNAKE action', () => {
    const actions = CLEANUP_STEPS.map((step) => STEP_ACTIONS[step]);
    assert.equal(new Set(actions).size, 12);
    assert.ok(actions.every((action) => /^[A-Z][A-Z0-9_]*$/.test(action)));
  });
});
