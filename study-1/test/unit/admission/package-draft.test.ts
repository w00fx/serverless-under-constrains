// The package draft (BR-RUA-040): every record is serialized, parsed back and validated before a
// byte is written; an invalid or unrepresentable record is named with at most three violations.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { draftFiles, recordFileSha256 } from '../../../src/admission/package-draft.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import { parseJsonDocument } from '../../../src/record-contract/parsing.ts';
import type { ExecutionManifest } from '../../../src/record-contract/records/group-a/execution_manifest.ts';
import type { StudyRecord } from '../../../src/record-contract/records/index.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { AdmissionHarness } from '../../support/admission/admission-harness.ts';

const validator = createRecordValidator();
const COPY = { path: 'admission/environment-input.json', bytes: new TextEncoder().encode('{}\n') };

async function admittedManifest(): Promise<ExecutionManifest> {
  const harness = await AdmissionHarness.create('TRANSPORT_PROBE');
  const outcome = await harness.admit();
  assert.ok(outcome.kind === 'admitted');
  const parsed = parseJsonDocument(await harness.evidenceFile(outcome.manifest_path));
  assert.ok(parsed.ok);
  return parsed.value as unknown as ExecutionManifest;
}

function reasonDetails(result: ReturnType<typeof draftFiles>): readonly string[] {
  return result.ok ? [] : result.error.map((reason) => reason.detail);
}

describe('draftFiles', () => {
  it('returns the copies, the records and the manifest bytes with their digest', async () => {
    const manifest = await admittedManifest();
    const draft = draftFiles([], [COPY], manifest, validator);
    assert.ok(draft.ok);
    assert.deepEqual(draft.value.files, [COPY]);
    assert.deepEqual(draft.value.manifest_bytes, serializeRecordFile(manifest));
    assert.equal(draft.value.manifest_sha256, sha256Hex(serializeRecordFile(manifest)));
    assert.equal(recordFileSha256(manifest), draft.value.manifest_sha256);
  });

  it('names an invalid record with at most three violations', async () => {
    const manifest = await admittedManifest();
    const invalid = { schema_version: 1, record_type: 'source_provenance' } as unknown as StudyRecord;
    const draft = draftFiles(
      [{ path: EXECUTION_PATHS.sourceProvenance, record_type: 'source_provenance', record: invalid }],
      [COPY],
      manifest,
      validator,
    );
    assert.ok(!draft.ok);
    assert.ok(draft.error.length >= 1 && draft.error.length <= 3, JSON.stringify(draft.error));
    assert.ok(draft.error.every((reason) => reason.code === 'DRAFT_RECORD_INVALID' && reason.subject === 'BR-RUA-040'));
    assert.match(reasonDetails(draft)[0] ?? '', /^admission\/source-provenance\.json at \/ violates required: /);
  });

  it('cuts a record with many violations to three', async () => {
    const manifest = await admittedManifest();
    const draft = draftFiles(
      [],
      [],
      { ...manifest, seed: -1, schema_version: 2, environment: null } as never,
      validator,
    );
    assert.ok(!draft.ok);
    assert.equal(draft.error.length, 3);
  });

  it('names a record that is not representable as JSON', async () => {
    const manifest = await admittedManifest();
    const draft = draftFiles([], [], { ...manifest, seed: Number.NaN } as never, validator);
    assert.deepEqual(reasonDetails(draft), [
      'admission/execution-manifest.json at / violates json: not representable as JSON',
    ]);
  });
});
