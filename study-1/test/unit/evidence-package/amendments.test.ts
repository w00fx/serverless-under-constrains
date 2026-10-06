// Immutable amendments (BR-RUA-043): an amendment package hashes its payload, names the original
// package index and the preceding amendment, and is refused when its sequence, parent, payload or
// required record is wrong.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { REQUIRED_PAYLOAD, buildAmendment } from '../../../src/evidence-package/amendments.ts';
import type { AmendmentInput } from '../../../src/evidence-package/amendments.ts';
import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import type { ExecutionIdentity } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { RUN_ID, at, digest, uuid } from '../../support/record-contract/record-builders.ts';
import { reasonCodes, textFile } from '../../support/evidence-package/package-files.ts';

const validator = createRecordValidator();
const RUN: ExecutionIdentity = { execution_kind: 'RUN', run_id: RUN_ID };

function amendment(overrides: Partial<AmendmentInput> = {}): AmendmentInput {
  return {
    identity: RUN,
    execution_manifest_sha256: digest('manifest'),
    amendment_id: uuid(0xa1),
    amendment_kind: 'BILLING',
    sequence: 1,
    original_package_index_sha256: digest('package-index'),
    parent_amendment_index_sha256: null,
    payload: [
      textFile('payload/billing-import.json', '{"billing":1}\n'),
      textFile('payload/billing-export/part-1.csv', 'a,b\n'),
    ],
    created_at: at(5),
    ...overrides,
  };
}

describe('buildAmendment', () => {
  it('builds the directory, a schema-valid index and the index as the last file', () => {
    const built = buildAmendment(amendment());
    assert.ok(built.ok);
    assert.equal(built.value.directory, `amendments/${RUN_ID}/0001-${uuid(0xa1)}`);
    assert.deepEqual(
      built.value.index.entries.map((entry) => [entry.artifact_path, entry.artifact_class, entry.derivation]),
      [
        ['payload/billing-export/part-1.csv', 'billing_export_file', 'primary'],
        ['payload/billing-import.json', 'billing_import', 'derived'],
      ],
    );
    const last = built.value.files.at(-1);
    assert.deepEqual(last, { path: 'amendment-index.json', bytes: serializeRecordFile(built.value.index) });
    assert.ok(validator.validateAs('amendment_index', JSON.parse(JSON.stringify(built.value.index)) as never).valid);
  });

  it('chains sequence n to the index digest of amendment n-1', () => {
    const built = buildAmendment(amendment({ sequence: 2, parent_amendment_index_sha256: digest('first') }));
    assert.ok(built.ok);
    assert.equal(built.value.index.parent_amendment_index_sha256, digest('first'));
  });

  it('refuses a sequence that is not a positive safe integer', () => {
    for (const sequence of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      const built = buildAmendment(amendment({ sequence }));
      assert.ok(!built.ok, String(sequence));
      assert.deepEqual(reasonCodes(built.error), ['INVALID_SEQUENCE']);
    }
  });

  it('refuses a parent on sequence 1 and a missing parent after it', () => {
    const first = buildAmendment(amendment({ parent_amendment_index_sha256: digest('x') }));
    const second = buildAmendment(amendment({ sequence: 2 }));
    assert.ok(!first.ok && !second.ok);
    assert.match(first.error[0]?.detail ?? '', /expected null for sequence 1/);
    assert.match(second.error[0]?.detail ?? '', /has parent null; expected the index digest of amendment 1/);
  });

  it('requires the record of its kind and refuses foreign payloads', () => {
    const missing = buildAmendment(amendment({ amendment_kind: 'REASSESSMENT', payload: [] }));
    assert.ok(!missing.ok);
    assert.deepEqual(
      missing.error.map((reason) => [reason.code, reason.artifact_path]),
      [['CORE_FILE_MISSING', REQUIRED_PAYLOAD.REASSESSMENT]],
    );
    const foreign = buildAmendment(amendment({ amendment_kind: 'OPERATIONAL_RECOVERY' }));
    assert.ok(!foreign.ok);
    assert.deepEqual(reasonCodes(foreign.error), [
      'CORE_FILE_MISSING',
      'PAYLOAD_NOT_ALLOWED_FOR_KIND',
      'PAYLOAD_NOT_ALLOWED_FOR_KIND',
    ]);
  });

  it('names the required record of every kind', () => {
    assert.deepEqual(REQUIRED_PAYLOAD, {
      LATE_EVIDENCE: 'payload/late-evidence-assessment.json',
      REASSESSMENT: 'payload/late-evidence-assessment.json',
      OPERATIONAL_RECOVERY: 'payload/operational-recovery-record.json',
      BILLING: 'payload/billing-import.json',
    });
  });
});
