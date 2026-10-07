// Conformance of the scripted probe runner with the `ProbeRunner` contract the probe executor
// keeps: one report per plan, naming the plan's probe; the gate consulted before answering; and a
// freeze that reaches P5 asks the runner's checkpoint exactly once.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ExecutionGate } from '../../../../src/execution-lifecycle/execution-gate.ts';
import type { StructuredReason } from '../../../../src/record-contract/primitives.ts';
import type { CoordinationCheckpointWriter } from '../../../../src/trial-execution/trial-execution-ports.ts';
import { OfflineProbeCloud } from '../../../support/offline-cloud/offline-probe-cloud.ts';
import { ScriptedExecutionLease } from './scripted-execution-lease.ts';
import { ScriptedProbeRunner } from './scripted-probe-runner.ts';

const plan = new OfflineProbeCloud().plan();

class CountingCheckpoint implements CoordinationCheckpointWriter {
  calls = 0;

  writeCheckpoint(): Promise<StructuredReason | undefined> {
    this.calls += 1;
    return Promise.resolve(undefined);
  }
}

describe('ScriptedProbeRunner', () => {
  it('answers a not-started probe named after the plan, records the plan and never checkpoints', async () => {
    const runner = new ScriptedProbeRunner();
    const checkpoint = new CountingCheckpoint();
    const report = await runner.execute(plan, new ExecutionGate(new ScriptedExecutionLease()), checkpoint);
    assert.equal(report.kind, 'not_started');
    assert.equal(report.transport_probe_id, plan.execution.transport_probe_id);
    assert.deepEqual(runner.plans(), [plan]);
    assert.equal(checkpoint.calls, 0);
  });

  it('runs the hook before reading the gate, checkpoints once and answers a failed freeze', async () => {
    const gate = new ExecutionGate(new ScriptedExecutionLease());
    const runner = new ScriptedProbeRunner('freeze_failed', () => gate.abort('SIGINT'));
    const checkpoint = new CountingCheckpoint();
    const report = await runner.execute(plan, gate, checkpoint);
    assert.equal(report.kind, 'freeze_failed');
    assert.match(JSON.stringify(report), /publication refused/);
    assert.equal(checkpoint.calls, 1);
    assert.deepEqual(runner.checkpoints(), [undefined]);
  });
});
