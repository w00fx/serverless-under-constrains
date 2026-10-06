// What cleanup acts on (design §10.4; BR-RUA-048, BR-RUA-050): ownership from the frozen resource
// manifest, the deployed targets when the deploy succeeded (the recorded mappings otherwise), every
// declared trial's treatment partition (the probe's own for a probe) and the snapshot's scope.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EVENT_SOURCE_MAPPING_RESOURCE_TYPE } from '../../../src/cleanup/resource-types.ts';
import { planCleanup } from '../../../src/execution-lifecycle/cleanup-plan.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import type { UtcMillis, Uuid4 } from '../../../src/record-contract/primitives.ts';
import type { ResourceManifest } from '../../../src/record-contract/records/group-a/resource_manifest.ts';
import { offlineExecution } from '../../support/offline-cloud/offline-execution.ts';
import {
  admittedOf,
  SOURCE_MAPPING_ID,
  targetsOf,
} from '../../integration/execution-lifecycle/support/execution-fixtures.ts';

const execution = offlineExecution('run');
const admitted = admittedOf(execution);
const runId = admitted.identity.execution_kind === 'RUN' ? admitted.identity.run_id : ('' as Uuid4);
const manifest = JSON.parse(
  new TextDecoder().decode(execution.core_files.get(EXECUTION_PATHS.resourceManifest)),
) as ResourceManifest;
const STARTED_AT = '2026-10-05T12:04:50.000Z' as UtcMillis;
const EMPTY_HISTORY = { entries: [], findings: [] };

describe('planCleanup', () => {
  it('targets what the succeeded deploy names and every declared trial partition', () => {
    const plan = planCleanup({
      admitted,
      resource_manifest: manifest,
      targets: targetsOf(execution),
      history: EMPTY_HISTORY,
      started_at: STARTED_AT,
    });
    assert.ok(plan.ok);
    const partitions = admitted.manifest.trials.map((trial) => `${runId}#${trial.trial_id}`);
    assert.deepEqual(plan.value.input.targets, {
      event_source_mapping_ids: [SOURCE_MAPPING_ID],
      treatment_partitions: partitions,
      durable_function_names: targetsOf(execution).durable_function_names,
    });
    assert.deepEqual(plan.value.snapshot.partition_keys, partitions);
    assert.equal(plan.value.snapshot.queues.length, 4);
    assert.deepEqual(plan.value.snapshot.durable_listings, [
      { ...targetsOf(execution).durable_caller, started_after: STARTED_AT },
    ]);
    assert.equal(plan.value.input.ownership.execution_id, runId);
  });

  it('falls back to the recorded mappings when the deploy named no targets', () => {
    const partial: ResourceManifest = {
      ...manifest,
      resources: [
        ...manifest.resources,
        {
          logical_id: 'SourceMapping',
          resource_type: EVENT_SOURCE_MAPPING_RESOURCE_TYPE,
          physical_id: 'recorded-mapping',
          resource_status: 'CREATE_COMPLETE',
        },
      ],
    };
    const plan = planCleanup({
      admitted,
      resource_manifest: partial,
      targets: undefined,
      history: EMPTY_HISTORY,
      started_at: STARTED_AT,
    });
    assert.ok(plan.ok);
    assert.deepEqual(plan.value.input.targets.event_source_mapping_ids, ['recorded-mapping']);
    assert.deepEqual(plan.value.input.targets.durable_function_names, []);
    assert.deepEqual(plan.value.snapshot.durable_listings, []);
    assert.deepEqual(plan.value.snapshot.queues, []);
  });

  it('targets the probe partition of a transport probe', () => {
    const probe = {
      ...admitted,
      identity: { execution_kind: 'TRANSPORT_PROBE' as const, transport_probe_id: runId },
    };
    const { run_id: _run, ...unscoped } = manifest as ResourceManifest & { run_id: Uuid4 };
    const probeManifest = { ...unscoped, transport_probe_id: runId } as unknown as ResourceManifest;
    const plan = planCleanup({
      admitted: probe,
      resource_manifest: probeManifest,
      targets: undefined,
      history: EMPTY_HISTORY,
      started_at: STARTED_AT,
    });
    assert.ok(plan.ok);
    assert.deepEqual(plan.value.input.targets.treatment_partitions, [`${runId}#probe`]);
  });

  it('refuses a resource manifest of another execution', () => {
    const plan = planCleanup({
      admitted,
      resource_manifest: { ...manifest, run_id: 'f0f0f0f0-0000-4000-8000-000000000001' as Uuid4 },
      targets: targetsOf(execution),
      history: EMPTY_HISTORY,
      started_at: STARTED_AT,
    });
    assert.equal(!plan.ok && plan.error.code, 'OWNERSHIP_CONTEXT_INVALID');
  });
});
