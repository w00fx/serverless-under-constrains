// The declared trials' plans (design §10.2 P4; BR-RUA-019, BR-RUA-028, BR-RUA-040; AC-RUA-008):
// every plan comes from the frozen manifests, in the manifest's order, and a trial whose variant
// the stack did not deploy is refused before any trial runs.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Uuid4 } from '../../../src/record-contract/primitives.ts';
import { asTrialExecution, planDeclaredTrials } from '../../../src/execution-lifecycle/trial-plans.ts';
import { offlineExecution, offlineTrialPlan } from '../../support/offline-cloud/offline-execution.ts';
import { admittedOf, targetsOf } from '../../integration/execution-lifecycle/support/execution-fixtures.ts';

const PROBE_ID = '7d2e4f60-1a2b-4c3d-8e4f-5a6b7c8d9e0f' as Uuid4;

describe('planDeclaredTrials', () => {
  for (const name of ['run', 'validation-conventional'] as const) {
    it(`plans every declared trial of the ${name} exactly as the frozen manifests name it`, () => {
      const execution = offlineExecution(name);
      const plans = planDeclaredTrials({
        admitted: admittedOf(execution),
        resource_manifest_sha256: execution.resource_manifest_sha256,
        targets: targetsOf(execution),
      });
      assert.equal(plans.ok, true);
      const expected = execution.declared.map((_, index) => offlineTrialPlan(execution, index + 1));
      assert.deepEqual(plans.value, expected);
    });
  }

  it('keeps the declared order, sequence 1 to n', () => {
    const execution = offlineExecution('run');
    const plans = planDeclaredTrials({
      admitted: admittedOf(execution),
      resource_manifest_sha256: execution.resource_manifest_sha256,
      targets: targetsOf(execution),
    });
    assert.deepEqual(plans.ok && plans.value.map((plan) => [plan.trial.sequence, plan.trial.variant_id]), [
      [1, 'conventional'],
      [2, 'durable'],
      [3, 'conventional'],
      [4, 'durable'],
    ]);
  });

  it('refuses a durable trial when the stack deployed no Durable caller', () => {
    const execution = offlineExecution('run');
    const { durable_caller: _caller, ...targets } = targetsOf(execution);
    const plans = planDeclaredTrials({
      admitted: admittedOf(execution),
      resource_manifest_sha256: execution.resource_manifest_sha256,
      targets,
    });
    assert.equal(plans.ok, false);
    assert.equal(plans.error.code, 'TRIAL_TARGETS_MISSING');
    assert.match(plans.error.detail, /trial 2 .* durable variant.*queues and Durable caller/);
  });

  it('refuses a trial whose variant queues the stack did not deploy', () => {
    const execution = offlineExecution('run');
    const targets = targetsOf(execution);
    const { conventional: _conventional, ...durableOnly } = targets.queues;
    const plans = planDeclaredTrials({
      admitted: admittedOf(execution),
      resource_manifest_sha256: execution.resource_manifest_sha256,
      targets: { ...targets, queues: durableOnly },
    });
    assert.equal(plans.ok, false);
    assert.match(plans.error.detail, /trial 1 .* conventional variant.*expected its queues among/);
  });
});

describe('asTrialExecution', () => {
  it('keeps a run and refuses a transport probe', () => {
    const admitted = admittedOf(offlineExecution('run'));
    assert.deepEqual(asTrialExecution(admitted), admitted);
    const probe = {
      ...admitted,
      identity: { execution_kind: 'TRANSPORT_PROBE' as const, transport_probe_id: PROBE_ID },
    };
    assert.equal(asTrialExecution(probe), undefined);
  });
});
