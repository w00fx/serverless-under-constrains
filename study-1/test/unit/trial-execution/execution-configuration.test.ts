// The A-09 execution configuration record: the execution's kind, its one identity field and its
// manifest digest, valid against the `provider_execution_configuration` schema.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonValue, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { executionConfigurationRecord } from '../../../src/trial-execution/execution-configuration.ts';
import { MANIFEST_SHA, RUN_ID } from './support/trial-execution-fixtures.ts';

const clock = { now: (): Date => new Date('2026-10-05T12:00:00.000Z') };
const validator = createRecordValidator();

describe('executionConfigurationRecord', () => {
  it('records a run and a variant validation under their own identity field', () => {
    const run = executionConfigurationRecord(
      { execution: { execution_kind: 'RUN', run_id: RUN_ID }, execution_manifest_sha256: MANIFEST_SHA },
      clock,
    );
    const validationId = '5f1c2a9e-8b4d-4c1e-9f00-1a2b3c4d5e6f' as Uuid4;
    const validation = executionConfigurationRecord(
      {
        execution: { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: validationId },
        execution_manifest_sha256: MANIFEST_SHA,
      },
      clock,
    );
    assert.deepEqual(run, {
      schema_version: 1,
      record_type: 'provider_execution_configuration',
      execution_kind: 'RUN',
      run_id: RUN_ID,
      execution_manifest_sha256: MANIFEST_SHA,
      written_at: '2026-10-05T12:00:00.000Z',
    });
    assert.equal(validation.variant_validation_id, validationId);
    for (const record of [run, validation]) {
      assert.equal(validator.validate(record as unknown as JsonValue).valid, true);
    }
  });
});
