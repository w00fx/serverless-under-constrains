// The kind-bound runner commands (design §10.2; AC-RUA-027, AC-RUA-025): `run execute` drives a
// canonical run through its four trials to a finalized package with a clean closure and its run
// summary, `validation execute` drives a variant validation through its two trials to its
// validation summary, and each command refuses an execution of another kind before acquiring the
// lease or touching the package.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { lifecycleValidator } from './support/execution-fixtures.ts';
import { RunnerWorld } from './support/runner-world.ts';

describe('AC-RUA-027 runCanonical drives the canonical run', () => {
  it('runs all four trials to a finalized package with a clean closure and its run summary', async () => {
    const world = await RunnerWorld.create();
    const outcome = await world.drive(world.runner.runCanonical());
    assert.equal(outcome.package_finalized, true);
    assert.equal(outcome.trials.length, 4);
    assert.ok(outcome.trials.every((trial) => trial.kind === 'frozen'));
    assert.equal(outcome.cleanup_status, 'succeeded');
    assert.equal(outcome.leak_audit_status, 'clean');
    assert.equal(outcome.lease_status, 'released');
    assert.deepEqual(outcome.reasons, []);
    const summary = world.record(EXECUTION_PATHS.runSummary);
    assert.equal(lifecycleValidator().validateAs('run_summary', summary as JsonValue).valid, true);
    assert.ok(world.file(EXECUTION_PATHS.comparisonAssessment) !== undefined);
  });
});

describe('AC-RUA-025 runValidation drives the variant validation', () => {
  it('runs both validation trials to a finalized package and its validation summary', async () => {
    const world = await RunnerWorld.create({ name: 'validation-conventional' });
    const outcome = await world.drive(world.runner.runValidation());
    assert.equal(outcome.package_finalized, true);
    assert.equal(outcome.trials.length, 2);
    assert.deepEqual(outcome.reasons, []);
    const summary = world.record(EXECUTION_PATHS.validationSummary);
    assert.equal(lifecycleValidator().validateAs('validation_summary', summary as JsonValue).valid, true);
  });
});

describe('the commands of another kind refuse a trial execution', () => {
  for (const [name, command, admits] of [
    ['run', 'runProbe', 'RUN'],
    ['run', 'runValidation', 'RUN'],
    ['validation-conventional', 'runCanonical', 'VARIANT_VALIDATION'],
    ['validation-conventional', 'runProbe', 'VARIANT_VALIDATION'],
  ] as const) {
    it(`${command} names the mismatch over a ${name} and acquires nothing`, async () => {
      const world = await RunnerWorld.create({ name });
      const before = world.cloud.packageFiles();
      const outcome = await world.runner[command]();
      assert.equal(outcome.package_finalized, false);
      assert.deepEqual(
        outcome.reasons.map((reason) => reason.code),
        ['EXECUTION_KIND_MISMATCH'],
      );
      assert.match(outcome.reasons[0]?.detail ?? '', new RegExp(`admits a ${admits}; expected a `));
      assert.deepEqual(world.lease.calls(), []);
      assert.deepEqual(world.cloud.packageFiles(), before);
    });
  }
});
