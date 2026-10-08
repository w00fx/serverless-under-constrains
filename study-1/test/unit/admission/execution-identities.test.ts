// Step A11 (IDENTITY; BR-RUA-019, BR-RUA-038, BR-RUA-040): the execution id, then the trial ids
// in their only allowed order; every id a distinct lowercase UUIDv4; a run or a validation
// without a selected probe declares nothing.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { declareExecution } from '../../../src/admission/execution-identities.ts';
import type { QualificationSelection } from '../../../src/admission/admission-ports.ts';
import type { Sha256Hex, Uuid4, UuidSource } from '../../../src/record-contract/primitives.ts';
import { SequentialUuidSource } from '../../support/kernel/sequential-uuid-source.ts';

const ATTEMPT = '0000a001-0000-4000-8000-000000000001' as Uuid4;
const SELECTION: QualificationSelection = {
  transport_probe_id: '2559d5f6-ec95-4777-a74e-452fcfde7526' as Uuid4,
  original_package_index_sha256: 'ab'.repeat(32) as Sha256Hex,
  amendment_head_sha256: null,
};
const id = (position: number): Uuid4 => `0000b002-0000-4000-8000-${position.toString(16).padStart(12, '0')}` as Uuid4;

describe('declareExecution (A11)', () => {
  it('a probe declares its id and no trial', () => {
    const verdict = declareExecution({ kind: 'TRANSPORT_PROBE' }, ATTEMPT, null, new SequentialUuidSource('0000b002'));
    assert.ok(verdict.passed);
    assert.deepEqual(verdict.value, {
      identity: { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: id(1) },
      execution_id: id(1),
      plan: { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: id(1), trials: [], qualification: null },
    });
  });

  it('a run declares four trials in RUN_TRIAL_ORDER with its selected probe', () => {
    const verdict = declareExecution({ kind: 'RUN' }, ATTEMPT, SELECTION, new SequentialUuidSource('0000b002'));
    assert.ok(verdict.passed);
    assert.deepEqual(verdict.value.plan, {
      execution_kind: 'RUN',
      run_id: id(1),
      trials: [
        { sequence: 1, trial_id: id(2), variant_id: 'conventional', scenario: 'CONTROL' },
        { sequence: 2, trial_id: id(3), variant_id: 'durable', scenario: 'CONTROL' },
        { sequence: 3, trial_id: id(4), variant_id: 'conventional', scenario: 'COMMIT_THEN_TIMEOUT' },
        { sequence: 4, trial_id: id(5), variant_id: 'durable', scenario: 'COMMIT_THEN_TIMEOUT' },
      ],
      qualification: {
        transport_probe_id: SELECTION.transport_probe_id,
        original_package_index_sha256: SELECTION.original_package_index_sha256,
      },
    });
    assert.deepEqual(verdict.statement.expected, { trials: 4, seed: 1 });
  });

  it('a validation declares its variant control then timeout, with an explicit head', () => {
    const head = 'cd'.repeat(32) as Sha256Hex;
    const verdict = declareExecution(
      { kind: 'VARIANT_VALIDATION', variant: 'conventional' },
      ATTEMPT,
      { ...SELECTION, amendment_head_sha256: head },
      new SequentialUuidSource('0000b002'),
    );
    assert.ok(verdict.passed);
    assert.deepEqual(verdict.value.identity, { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: id(1) });
    assert.deepEqual(verdict.value.plan, {
      execution_kind: 'VARIANT_VALIDATION',
      variant_validation_id: id(1),
      variant_id: 'conventional',
      trials: [
        { sequence: 1, trial_id: id(2), variant_id: 'conventional', scenario: 'CONTROL' },
        { sequence: 2, trial_id: id(3), variant_id: 'conventional', scenario: 'COMMIT_THEN_TIMEOUT' },
      ],
      qualification: { ...SELECTION, amendment_head_sha256: head },
    });
  });

  it('refuses a run or a validation without a selected probe, drawing no id', () => {
    const ids = new SequentialUuidSource('0000b002');
    const verdict = declareExecution({ kind: 'VARIANT_VALIDATION', variant: 'durable' }, ATTEMPT, null, ids);
    assert.ok(!verdict.passed);
    assert.deepEqual(verdict.reasons, [
      {
        code: 'EXECUTION_QUALIFICATION_MISSING',
        subject: 'BR-RUA-040',
        detail: 'a VARIANT_VALIDATION has no selected probe; expected one',
      },
    ]);
    assert.equal(ids.issuedCount(), 0);
  });

  it('refuses a repeated id', () => {
    const ids = new SequentialUuidSource('0000b002');
    ids.next();
    ids.repeatNext();
    const verdict = declareExecution({ kind: 'TRANSPORT_PROBE' }, id(1), null, ids);
    assert.ok(!verdict.passed);
    assert.equal(verdict.rejection_class, 'IDENTITY');
    assert.deepEqual(
      verdict.reasons.map((reason) => reason.code),
      ['EXECUTION_ID_COLLISION'],
    );
  });

  it('refuses an id that is not a lowercase UUIDv4', () => {
    const upper: UuidSource = { next: () => 'ABCDEF00-0000-4000-8000-000000000001' as Uuid4 };
    const verdict = declareExecution({ kind: 'TRANSPORT_PROBE' }, ATTEMPT, null, upper);
    assert.ok(!verdict.passed);
    assert.deepEqual(verdict.reasons[0], {
      code: 'EXECUTION_ID_INVALID',
      subject: 'BR-RUA-040',
      detail: 'generated id ABCDEF00-0000-4000-8000-000000000001 is not a lowercase UUIDv4; expected one',
    });
  });
});
