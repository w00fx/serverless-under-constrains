// Conformance of the scripted trial runner with the `TrialRunner` contract the executor keeps:
// one report per plan, naming the plan's trial, and the gate consulted before answering.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ExecutionGate } from '../../../../src/execution-lifecycle/execution-gate.ts';
import { offlineExecution, offlineTrialPlan } from '../../../support/offline-cloud/offline-execution.ts';
import { ScriptedExecutionLease } from './scripted-execution-lease.ts';
import { ScriptedTrialRunner } from './scripted-trial-runner.ts';

const execution = offlineExecution('run');

describe('ScriptedTrialRunner', () => {
  it('answers a not-started trial named after the plan, and records the plan', async () => {
    const runner = new ScriptedTrialRunner();
    const plan = offlineTrialPlan(execution, 1);
    const report = await runner.execute(plan, new ExecutionGate(new ScriptedExecutionLease()));
    assert.equal(report.kind, 'not_started');
    assert.equal(report.trial_id, plan.trial.trial_id);
    assert.deepEqual(runner.plans(), [plan]);
  });

  it('runs the hook with the sequence before reading the gate, and answers a failed freeze', async () => {
    const gate = new ExecutionGate(new ScriptedExecutionLease());
    const seen: number[] = [];
    const runner = new ScriptedTrialRunner('freeze_failed', (sequence) => {
      seen.push(sequence);
      gate.abort('SIGINT');
    });
    const report = await runner.execute(offlineTrialPlan(execution, 2), gate);
    assert.deepEqual(seen, [2]);
    assert.equal(report.kind, 'freeze_failed');
    assert.match(report.reasons[0]?.detail ?? '', /publication refused/);
  });
});
