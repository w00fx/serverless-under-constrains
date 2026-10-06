// The leak audit (BR-RUA-051, design §8.18, §9.14) against stubbed surfaces on virtual time: two
// passes at least 120 s of monotonic time apart (re-armed after an early wake-up, RK-03), owned
// sightings as leaks with their D-30 capability class, ambiguous resources reported and never
// leaks, baseline ignored, and every result schema-valid.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LeakAuditor, MAX_STABILITY_SLEEPS } from '../../../src/cleanup/leak-auditor.ts';
import { resourceKey } from '../../../src/cleanup/resource-names.ts';
import {
  DURABLE_EXECUTION_RESOURCE_TYPE,
  FUNCTION_RESOURCE_TYPE,
  STACK_RESOURCE_TYPE,
  TABLE_RESOURCE_TYPE,
} from '../../../src/cleanup/resource-types.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import type { LeakAuditResult } from '../../../src/record-contract/records/group-c/leak_audit_result.ts';
import {
  discovered,
  EPOCH_MS,
  EXECUTION,
  EXECUTION_ID,
  MANIFEST_SHA,
  NAMES,
  ownershipContext,
  runInfrastructure,
  STACK_ID,
  STACK_MEMBERS,
  tagged,
} from '../../support/cleanup/cleanup-fixtures.ts';
import { cleanupValidator } from '../../support/cleanup/cleanup-harness.ts';
import { SelfAdvancingSleeper } from '../../support/cleanup/self-advancing-sleeper.ts';
import { StubDiscoverySurfaces } from '../../support/cleanup/stub-discovery-surfaces.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';

interface AuditRig {
  readonly surfaces: StubDiscoverySurfaces;
  readonly sleeper: SelfAdvancingSleeper;
  readonly time: VirtualTimeScheduler;
  readonly audit: () => Promise<LeakAuditResult>;
}

function auditRig(): AuditRig {
  const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS, monotonicOriginNs: 7_000_000_000n });
  const surfaces = new StubDiscoverySurfaces();
  const sleeper = new SelfAdvancingSleeper(time);
  const auditor = new LeakAuditor({ surfaces, clock: time, monotonic: time, sleeper });
  return {
    surfaces,
    sleeper,
    time,
    audit: async (): Promise<LeakAuditResult> => {
      const result = await auditor.audit({
        execution: EXECUTION,
        execution_manifest_sha256: MANIFEST_SHA,
        ownership: ownershipContext(),
      });
      const validation = cleanupValidator().validateAs('leak_audit_result', result as unknown as JsonValue);
      assert.ok(validation.valid, JSON.stringify(validation));
      return result;
    },
  };
}

function observedBySurface(result: LeakAuditResult, pass: number): Record<string, readonly string[]> {
  return Object.fromEntries(
    (result.passes[pass]?.surfaces ?? [])
      .filter((surface) => surface.observed.length > 0)
      .map((surface) => [surface.surface, surface.observed]),
  );
}

describe('LeakAuditor', () => {
  it('is clean after two absent passes 120 s apart, re-arming after an early wake-up', async () => {
    const rig = auditRig();
    rig.sleeper.wakeEarlyBy(1);
    const result = await rig.audit();
    assert.equal(result.leak_audit_status, 'clean');
    assert.deepEqual(rig.sleeper.requests(), [120_000, 1]);
    assert.equal(result.stable_absence_interval_ms, 120_000);
    assert.equal(result.passes.length, 2);
    assert.equal(result.passes[0]?.started_at, '2026-10-05T12:00:00.000Z');
    assert.equal(result.passes[1]?.started_at, '2026-10-05T12:02:00.000Z');
    assert.equal(result.audited_at, '2026-10-05T12:02:00.000Z');
    assert.ok('run_id' in result && result.run_id === EXECUTION_ID);
    assert.equal(result.execution_manifest_sha256, MANIFEST_SHA);
  });

  it('runs one pass only, inconclusive, when the wait never reaches 120 s', async () => {
    const rig = auditRig();
    rig.sleeper.stall();
    const result = await rig.audit();
    assert.equal(result.leak_audit_status, 'inconclusive');
    assert.equal(result.passes.length, 1);
    assert.equal(result.stable_absence_interval_ms, 0);
    assert.equal(rig.sleeper.requests().length, MAX_STABILITY_SLEEPS);
  });

  it('reports every owned resource still observed once, with its capability class and strongest basis, in sighting order', async () => {
    const rig = auditRig();
    rig.surfaces.place(...runInfrastructure(STACK_MEMBERS.filter((member) => member.surface === 'tables')));
    rig.surfaces.place(
      discovered(DURABLE_EXECUTION_RESOURCE_TYPE, 'arn:durable/1', 'durable_executions', {
        tags: { kind: 'untaggable' },
        managed_by_stack_id: STACK_ID,
      }),
    );
    const result = await rig.audit();
    assert.equal(result.leak_audit_status, 'leaks_detected');
    assert.deepEqual(
      result.leaks.map((leak) => [leak.resource_type, leak.surface, leak.capability_class, leak.ownership_basis]),
      [
        [TABLE_RESOURCE_TYPE, 'tag_index', 'storage_only', 'resource_manifest_and_tags'],
        [STACK_RESOURCE_TYPE, 'stack', 'processing_capable', 'recorded_stack'],
        [DURABLE_EXECUTION_RESOURCE_TYPE, 'durable_executions', 'processing_capable', 'recorded_stack'],
      ],
    );
    for (const pass of [0, 1]) {
      assert.deepEqual(observedBySurface(result, pass), {
        tag_index: [NAMES.controlTable],
        stack: [STACK_ID],
        stack_resources: [NAMES.controlTable],
        durable_executions: ['arn:durable/1'],
        tables: [NAMES.controlTable],
      });
    }
  });

  it('keeps a leak seen only in the first pass: absence that is not stable is not proven', async () => {
    const rig = auditRig();
    const table = discovered(TABLE_RESOURCE_TYPE, NAMES.controlTable, 'tables');
    rig.surfaces.place(table);
    rig.surfaces.lagAbsence(resourceKey(table), 1);
    rig.surfaces.remove(resourceKey(table));
    const result = await rig.audit();
    assert.equal(result.leak_audit_status, 'leaks_detected');
    assert.deepEqual(observedBySurface(result, 0), { tables: [NAMES.controlTable] });
    assert.deepEqual(observedBySurface(result, 1), {});
    assert.deepEqual(
      result.leaks.map((leak) => leak.identifier),
      [NAMES.controlTable],
    );
  });

  it('reports an ambiguous resource with its reasons, never as a leak or an observation', async () => {
    const rig = auditRig();
    const stray = discovered(FUNCTION_RESOURCE_TYPE, `${NAMES.providerFunction}-stray`, 'functions', {
      tags: tagged([{ key: 'suc:project', value: 'serverless-under-constraints' }]),
    });
    rig.surfaces.place(stray, discovered(STACK_RESOURCE_TYPE, 'CDKToolkit', 'stack'));
    const result = await rig.audit();
    assert.equal(result.leak_audit_status, 'inconclusive');
    assert.deepEqual(result.leaks, []);
    assert.deepEqual(
      result.ambiguous.map((entry) => [entry.identifier, entry.surface, entry.reasons.map((reason) => reason.code)]),
      [[stray.identifier, 'functions', ['NOT_IN_COMPLETE_MANIFEST', 'RUN_TAGS_NOT_PROVEN']]],
    );
    assert.deepEqual(observedBySurface(result, 0), {});
  });

  it('is inconclusive when one surface query failed in one pass', async () => {
    const rig = auditRig();
    rig.surfaces.failQuery('roles', 1);
    const result = await rig.audit();
    assert.equal(result.leak_audit_status, 'inconclusive');
    assert.deepEqual(
      result.passes.map((pass) =>
        pass.surfaces.filter((surface) => !surface.query_ok).map((surface) => surface.surface),
      ),
      [['roles'], []],
    );
  });
});
