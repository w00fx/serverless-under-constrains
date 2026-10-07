// The late-record capture plan of cleanup step 1 (BR-RUA-043; design §10.4 step 1): only units whose
// evidence index exists are re-read, each with the exact bytes it froze; a queued trial is re-read
// from its variant's DLQ when the targets name one; a Durable trial re-lists exactly the listing its
// frozen `durable-executions.json` records, and a record that cannot be read lists nothing; the
// execution-level copies are the packaged readiness and A-09 journals that exist.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readAdmittedExecution } from '../../../src/execution-lifecycle/admitted-execution.ts';
import type { AdmittedExecution } from '../../../src/execution-lifecycle/execution-ports.ts';
import { lateCapturePlan } from '../../../src/execution-lifecycle/late-capture-plan.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import type { EvidenceUnit } from '../../../src/evidence-package/package-layout.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import { frozenCoreFiles, offlineExecution } from '../../support/offline-cloud/offline-execution.ts';
import {
  admittedOf,
  lifecycleValidator,
  targetsOf,
} from '../../integration/execution-lifecycle/support/execution-fixtures.ts';

const RUN = offlineExecution('run');
const ADMITTED = admittedOf(RUN);
const TARGETS = targetsOf(RUN);
const [FIRST, SECOND] = ADMITTED.manifest.trials;
assert.ok(FIRST !== undefined && SECOND !== undefined, 'the golden run declares trials');
const FIRST_UNIT: EvidenceUnit = { kind: 'trial', trial_id: FIRST.trial_id };
const SECOND_UNIT: EvidenceUnit = { kind: 'trial', trial_id: SECOND.trial_id };
const MANIFEST_BYTES = new TextEncoder().encode('{"trial":"manifest"}\n');
const LISTING = {
  function_arn: 'arn:aws:lambda:eu-west-1:111122223333:function:suc1-durable-caller',
  qualifier: '3',
  started_after: '2026-10-05T12:00:00.000Z',
};

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// A trial frozen as T11 leaves it: its manifest, its journals and, last, its evidence index.
function frozenTrial(unit: EvidenceUnit, extra: readonly [string, Uint8Array][] = []): [string, Uint8Array][] {
  return [
    [PACKAGE_LAYOUT.unitFile(unit, 'trialManifest'), MANIFEST_BYTES],
    [PACKAGE_LAYOUT.unitFile(unit, 'callerJournal'), bytesOf('caller\n')],
    [PACKAGE_LAYOUT.unitFile(unit, 'evidenceIndex'), bytesOf('{}\n')],
    ...extra,
  ];
}

function durableListing(unit: EvidenceUnit, text: string): [string, Uint8Array] {
  return [PACKAGE_LAYOUT.unitFile(unit, 'durableExecutions'), bytesOf(text)];
}

function probeAdmitted(): AdmittedExecution {
  const bytes = frozenCoreFiles('probe').core_files.get(EXECUTION_PATHS.executionManifest) ?? new Uint8Array();
  const admitted = readAdmittedExecution(bytes, lifecycleValidator());
  assert.ok(admitted.ok, 'the golden probe manifest is admitted');
  return admitted.value;
}

describe('lateCapturePlan', () => {
  it('re-reads only the frozen trials, each with its frozen copies and its DLQ', () => {
    const files = new Map([
      ...frozenTrial(FIRST_UNIT),
      // The second trial froze its manifest but never its index: it is not re-read.
      [PACKAGE_LAYOUT.unitFile(SECOND_UNIT, 'trialManifest'), MANIFEST_BYTES],
    ]);
    const plan = lateCapturePlan(files, ADMITTED, TARGETS);
    assert.deepEqual(plan.execution, ADMITTED.identity);
    assert.equal(plan.execution_manifest_sha256, ADMITTED.manifest_sha256);
    assert.deepEqual(plan.units, [
      {
        unit: { ...FIRST_UNIT, trial_manifest_sha256: sha256Hex(MANIFEST_BYTES) },
        dlq: TARGETS.queues[FIRST.variant_id]?.dlq,
        frozen: { callerJournal: bytesOf('caller\n') },
      },
    ]);
    assert.deepEqual(plan.execution_frozen, {});
  });

  it('skips a trial whose index exists without its manifest', () => {
    const files = new Map([[PACKAGE_LAYOUT.unitFile(FIRST_UNIT, 'evidenceIndex'), bytesOf('{}\n')]]);
    assert.deepEqual(lateCapturePlan(files, ADMITTED, TARGETS).units, []);
  });

  it('re-reads no DLQ without targets', () => {
    const [unit] = lateCapturePlan(new Map(frozenTrial(FIRST_UNIT)), ADMITTED, undefined).units;
    assert.ok(unit !== undefined);
    assert.equal('dlq' in unit, false);
  });

  it('re-lists exactly the frozen Durable listing', () => {
    const files = new Map(frozenTrial(FIRST_UNIT, [durableListing(FIRST_UNIT, JSON.stringify(LISTING))]));
    const [unit] = lateCapturePlan(files, ADMITTED, TARGETS).units;
    assert.deepEqual(unit?.durable, LISTING);
  });

  for (const [name, text] of [
    ['is not JSON', '{"function_arn":'],
    ['names no function', JSON.stringify({ ...LISTING, function_arn: undefined })],
    ['names no qualifier', JSON.stringify({ ...LISTING, qualifier: 7 })],
    ['names no publication instant', JSON.stringify({ ...LISTING, started_after: undefined })],
    ['names an instant that is not UTC milliseconds', JSON.stringify({ ...LISTING, started_after: '2026-10-05' })],
    ['is not an object', JSON.stringify([LISTING])],
  ] as const) {
    it(`lists nothing when the frozen listing ${name}`, () => {
      const files = new Map(frozenTrial(FIRST_UNIT, [durableListing(FIRST_UNIT, text)]));
      const [unit] = lateCapturePlan(files, ADMITTED, TARGETS).units;
      assert.ok(unit !== undefined);
      assert.equal('durable' in unit, false);
    });
  }

  it('carries the packaged execution-level journals that exist', () => {
    const files = new Map([
      [EXECUTION_PATHS.canaryCallerJournal, bytesOf('canary\n')],
      [EXECUTION_PATHS.executionProviderJournal, bytesOf('provider\n')],
    ]);
    assert.deepEqual(lateCapturePlan(files, ADMITTED, TARGETS).execution_frozen, {
      canaryCallerJournal: bytesOf('canary\n'),
      executionProviderJournal: bytesOf('provider\n'),
    });
  });

  it('re-reads the probe once frozen, and nothing before', () => {
    const admitted = probeAdmitted();
    const probe: EvidenceUnit = { kind: 'probe' };
    const journal: [string, Uint8Array] = [PACKAGE_LAYOUT.unitFile(probe, 'providerJournal'), bytesOf('p\n')];
    assert.deepEqual(lateCapturePlan(new Map([journal]), admitted, undefined).units, []);
    const frozen = new Map([journal, [PACKAGE_LAYOUT.unitFile(probe, 'evidenceIndex'), bytesOf('{}\n')]]);
    assert.deepEqual(lateCapturePlan(frozen, admitted, undefined).units, [
      { unit: probe, frozen: { providerJournal: bytesOf('p\n') } },
    ]);
  });
});
