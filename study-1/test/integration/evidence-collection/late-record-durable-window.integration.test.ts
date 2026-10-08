// Which trial a re-listed Durable execution is late evidence of (BR-RUA-043, AC-RUA-030; design
// §8.13, §10.4 step 1). The Durable listing has no trial filter: every Durable trial of a run lists
// the same caller function and alias from its own publication on, and the trials run one after
// another (spec: "The canonical run contains exactly four sequential trials"). Re-listing an earlier
// trial therefore also returns every later trial's executions, which that trial never froze. Each
// case freezes sequential trials with the production collector over the scripted reader (which,
// like a lax endpoint, lists every execution whatever the bound), writes executions after the
// freezes, and proves each new execution is captured once, for the trial whose window holds its
// start (CMP-03 review F3).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DurableListingRequest } from '../../../src/evidence-collection/durable-metadata.ts';
import { captureLateRecords } from '../../../src/evidence-collection/late-record-capture.ts';
import type { LateCaptureUnit, LateRecordStream } from '../../../src/evidence-collection/late-record-capture.ts';
import type { JsonObject, UtcMillis, Uuid4 } from '../../../src/record-contract/primitives.ts';
import {
  assertValidRecord,
  DURABLE_FUNCTION_ARN,
  sdkEvent,
  sdkExecution,
} from '../../support/evidence-collection/collection-fixtures.ts';
import {
  freezePlan,
  freezeUnit,
  LATE_DURABLE,
  lateCaptureSurfaces,
} from '../../support/evidence-collection/late-record-fixtures.ts';
import type { LateCaptureSurfaces } from '../../support/evidence-collection/late-record-fixtures.ts';
import { TRIAL_ID, TRIAL_MANIFEST_SHA256 } from '../../support/record-contract/record-builders.ts';

const SECOND_TRIAL = '00000000-0000-4000-8000-000000000998' as Uuid4;
const THIRD_TRIAL = '00000000-0000-4000-8000-000000000997' as Uuid4;

type PlannedUnit = Omit<LateCaptureUnit, 'frozen'>;

// A Durable trial of the fixture caller published `second` seconds after 12:05:00 (sdkExecution(n)
// starts at 12:05:n), listing the fixture alias unless `listing` names another caller or alias.
function durableTrial(trialId: Uuid4, second: number, listing: Partial<DurableListingRequest> = {}): PlannedUnit {
  const startedAfter = new Date(Date.UTC(2026, 9, 5, 12, 5, second)).toISOString() as UtcMillis;
  return {
    unit: { kind: 'trial', trial_id: trialId, trial_manifest_sha256: TRIAL_MANIFEST_SHA256 },
    durable: { ...LATE_DURABLE, ...listing, started_after: startedAfter },
  };
}

function addExecutions(surfaces: LateCaptureSurfaces, serials: readonly number[]): void {
  for (const serial of serials) {
    surfaces.durable.addExecution(sdkExecution(serial, 'FAILED'), [sdkEvent('ExecutionStarted', 1)]);
  }
}

async function capturedStream(
  surfaces: LateCaptureSurfaces,
  units: readonly LateCaptureUnit[],
): Promise<LateRecordStream> {
  const plan = { ...(await freezePlan(surfaces, [])), units };
  const result = await captureLateRecords(surfaces.ports, plan);
  assert.ok(result.ok, `expected a captured stream, got ${JSON.stringify(result.ok ? [] : result.error)}`);
  for (const record of result.value.records) {
    assertValidRecord(record, 'late_evidence_record');
  }
  return result.value;
}

// The late Durable executions of each trial, by execution name, in trial id order.
function lateExecutionsByTrial(stream: LateRecordStream): readonly (readonly [string, readonly unknown[]])[] {
  return stream.records
    .filter((record) => record['late_source'] === 'DURABLE_EXECUTION_METADATA')
    .map((record): readonly [string, readonly unknown[]] => {
      const executions = (record['late_record'] as JsonObject)['executions'] as readonly JsonObject[];
      return [record['trial_id'] as string, executions.map((execution) => execution['durable_execution_name'])];
    })
    .sort((left, right) => left[0].localeCompare(right[0]));
}

describe('captureLateRecords: the listing window of a Durable trial', () => {
  it('captures each new execution once, for the sequential trial whose publication window holds its start', async () => {
    const surfaces = lateCaptureSurfaces();
    const frozen: LateCaptureUnit[] = [];
    addExecutions(surfaces, [1]);
    frozen.push(await freezeUnit(surfaces, durableTrial(TRIAL_ID, 0)));
    addExecutions(surfaces, [11]);
    frozen.push(await freezeUnit(surfaces, durableTrial(SECOND_TRIAL, 10)));
    addExecutions(surfaces, [21]);
    frozen.push(await freezeUnit(surfaces, durableTrial(THIRD_TRIAL, 20)));
    // After every freeze: executions on and around each publication instant.
    addExecutions(surfaces, [0, 9, 10, 12, 20, 25]);
    const expected = [
      [TRIAL_ID, ['exec-0', 'exec-9']],
      [THIRD_TRIAL, ['exec-20', 'exec-25']],
      [SECOND_TRIAL, ['exec-10', 'exec-12']],
    ];
    assert.deepEqual(lateExecutionsByTrial(await capturedStream(surfaces, frozen)), expected);
    // The window does not depend on the order the plan lists the trials in.
    assert.deepEqual(lateExecutionsByTrial(await capturedStream(surfaces, [...frozen].reverse())), expected);
  });

  it('ends a trial window only at a later publication of the same caller function and alias', async () => {
    const surfaces = lateCaptureSurfaces();
    const frozen: LateCaptureUnit[] = [];
    for (const planned of [
      durableTrial(TRIAL_ID, 0),
      durableTrial(SECOND_TRIAL, 3, { function_arn: `${DURABLE_FUNCTION_ARN}-other` }),
      durableTrial(THIRD_TRIAL, 4, { qualifier: '4' }),
    ]) {
      frozen.push(await freezeUnit(surfaces, planned));
    }
    addExecutions(surfaces, [5]);
    assert.deepEqual(lateExecutionsByTrial(await capturedStream(surfaces, frozen)), [
      [TRIAL_ID, ['exec-5']],
      [THIRD_TRIAL, ['exec-5']],
      [SECOND_TRIAL, ['exec-5']],
    ]);
  });
});
