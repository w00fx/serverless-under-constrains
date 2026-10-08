// What the composition learns while an execution runs (design §10.2 P2, P4): the latch keeps the
// stack P2 froze (and ignores a P2 that froze nothing), and the start registry keeps each unit's
// first start instant under the key the telemetry lookups read it by.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { telemetryUnit } from '../../../src/evidence-collection/telemetry-targets.ts';
import type { ExecutionTargets, ProvisioningOutcome } from '../../../src/execution-lifecycle/execution-ports.ts';
import {
  DeploymentLatch,
  PROBE_UNIT_START_KEY,
  UnitStartRegistry,
} from '../../../src/operator-cli/deployment-latch.ts';
import type { Sha256Hex } from '../../../src/record-contract/primitives.ts';
import type { ResourceManifest } from '../../../src/record-contract/records/group-a/resource_manifest.ts';
import { PROBE_BINDING, PROBE_EXECUTION_SCOPE } from '../../support/evidence-collection/telemetry-fixtures.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';

const MANIFEST = { stack_name: 'suc1-b42ee7a8' } as unknown as ResourceManifest;
const TARGETS = { provider_version: '7' } as unknown as ExecutionTargets;
const DIGEST = 'a'.repeat(64) as Sha256Hex;
const REFUSED = { code: 'STACK_TAGS_REFUSED', subject: 'BR-RUA-050', detail: 'refused' };

describe('DeploymentLatch', () => {
  it('holds nothing until P2 froze a resource manifest', () => {
    const latch = new DeploymentLatch();
    assert.equal(latch.deployed(), undefined);
    latch.record({ reasons: [REFUSED] });
    assert.equal(latch.deployed(), undefined);
  });

  it('holds the frozen manifest, with the targets only when the deploy named them', () => {
    const latch = new DeploymentLatch();
    latch.record({ resource_manifest: MANIFEST, resource_manifest_sha256: DIGEST, reasons: [REFUSED] });
    assert.deepEqual(latch.deployed(), { resource_manifest: MANIFEST });
    const outcome: ProvisioningOutcome = {
      resource_manifest: MANIFEST,
      resource_manifest_sha256: DIGEST,
      targets: TARGETS,
      reasons: [],
    };
    latch.record(outcome);
    assert.deepEqual(latch.deployed(), { resource_manifest: MANIFEST, targets: TARGETS });
  });

  it('keeps the last frozen stack when a later outcome froze nothing', () => {
    const latch = new DeploymentLatch();
    latch.record({ resource_manifest: MANIFEST, resource_manifest_sha256: DIGEST, targets: TARGETS, reasons: [] });
    const held = latch.deployed();
    latch.record({ reasons: [REFUSED] });
    assert.equal(latch.deployed(), held);
  });
});

describe('UnitStartRegistry', () => {
  it('keeps the first start of each unit at the clock instant, as a live view', async () => {
    const clock = new VirtualTimeScheduler({ wallEpochMs: Date.parse('2026-10-05T12:03:00.000Z') });
    const starts = new UnitStartRegistry(clock);
    const view = starts.view();
    starts.record('trial-1');
    await clock.advanceBy(60_000);
    starts.record('trial-1');
    starts.record(PROBE_UNIT_START_KEY);
    assert.deepEqual(
      [...view],
      [
        ['trial-1', '2026-10-05T12:03:00.000Z'],
        ['probe', '2026-10-05T12:04:00.000Z'],
      ],
    );
  });

  it('stores the probe under the unit key the telemetry lookups read', () => {
    const unit = telemetryUnit(PROBE_BINDING, PROBE_EXECUTION_SCOPE);
    assert.equal(unit.ok, true);
    assert.equal(unit.value.unit_key, PROBE_UNIT_START_KEY);
  });
});
