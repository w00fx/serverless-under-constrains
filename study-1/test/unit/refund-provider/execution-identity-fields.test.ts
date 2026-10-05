// The `execution_identity` rule shared by the provider payload guards (BR-RUA-033): exactly one
// execution field, as a lowercase UUIDv4, and execution equality by kind and id.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeExecution,
  executionIdentityOf,
  parseExecutionIdentityFields,
  sameExecution,
} from '../../../src/refund-provider/execution-identity-fields.ts';
import { PROBE, PROBE_ID, RUN, RUN_ID, VALIDATION, VALIDATION_ID } from './support/provider-fixtures.ts';

describe('parseExecutionIdentityFields', () => {
  it('reads each of the three execution kinds', () => {
    assert.deepEqual(parseExecutionIdentityFields({ run_id: RUN_ID }), { ok: true, value: RUN });
    assert.deepEqual(parseExecutionIdentityFields({ transport_probe_id: PROBE_ID }), { ok: true, value: PROBE });
    assert.deepEqual(parseExecutionIdentityFields({ variant_validation_id: VALIDATION_ID }), {
      ok: true,
      value: VALIDATION,
    });
  });

  it('refuses none, several, or a malformed id', () => {
    const expected = 'expected exactly one of run_id, variant_validation_id, transport_probe_id';
    assert.deepEqual(parseExecutionIdentityFields({}), {
      ok: false,
      error: `execution identity fields []; ${expected}`,
    });
    assert.deepEqual(
      parseExecutionIdentityFields({
        run_id: RUN_ID,
        variant_validation_id: VALIDATION_ID,
        transport_probe_id: PROBE_ID,
      }),
      {
        ok: false,
        error: `execution identity fields [run_id, variant_validation_id, transport_probe_id]; ${expected}`,
      },
    );
    assert.deepEqual(parseExecutionIdentityFields({ variant_validation_id: null }), {
      ok: false,
      error: 'variant_validation_id is null null; expected a lowercase RFC 4122 version-4 UUID',
    });
  });
});

describe('execution helpers', () => {
  it('builds, compares and describes executions by kind and id', () => {
    assert.deepEqual(executionIdentityOf('RUN', RUN_ID), RUN);
    assert.deepEqual(executionIdentityOf('TRANSPORT_PROBE', PROBE_ID), PROBE);
    assert.deepEqual(executionIdentityOf('VARIANT_VALIDATION', VALIDATION_ID), VALIDATION);
    assert.equal(sameExecution(RUN, { execution_kind: 'RUN', run_id: RUN_ID }), true);
    assert.equal(sameExecution(RUN, { execution_kind: 'RUN', run_id: PROBE_ID }), false);
    assert.equal(sameExecution(RUN, { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: RUN_ID }), false);
    assert.equal(describeExecution(RUN), `RUN ${RUN_ID}`);
    assert.equal(describeExecution(PROBE), `TRANSPORT_PROBE ${PROBE_ID}`);
    assert.equal(describeExecution(VALIDATION), `VARIANT_VALIDATION ${VALIDATION_ID}`);
  });
});
