// The provenance condition of study completion (BR-RUA-054 with BR-RUA-042, BR-RUA-028): the stored
// source provenance is the one the manifest froze, and the manifest's qualification is exactly the
// selected probe with the same transport-scope snapshot.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import type { Sha256Hex } from '../../../src/record-contract/primitives.ts';
import type { ExecutionManifest } from '../../../src/record-contract/records/group-a/execution_manifest.ts';
import type { SourceProvenance } from '../../../src/record-contract/records/group-a/source_provenance.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { readRecordFile } from '../../../src/study-comparison/record-files.ts';
import type { FrozenRecord } from '../../../src/study-comparison/record-files.ts';
import { qualificationReasons, sourceReasons } from '../../../src/study-comparison/study-provenance.ts';
import { BASE_QUALIFICATION } from '../../golden/study-comparison/support/run-fixture.ts';
import { READ_DEPS, cleanRunRecords, probeManifestBytes } from './support/clean-run.ts';

let manifest: FrozenRecord<ExecutionManifest>;
let provenance: FrozenRecord<SourceProvenance>;

before(async () => {
  const records = await cleanRunRecords();
  manifest = records.execution_manifest;
  assert.ok(records.source_provenance !== undefined);
  provenance = records.source_provenance;
});

const OTHER = 'f'.repeat(64) as Sha256Hex;

function subjects(reasons: readonly { readonly code: string; readonly subject: string }[]): readonly string[] {
  return reasons.map(({ code, subject }) => `${code}:${subject}`);
}

describe('sourceReasons', () => {
  it('is empty for the provenance the manifest froze', () => {
    assert.deepEqual(sourceReasons(manifest, provenance), []);
  });

  it('names a missing manifest or a missing provenance', () => {
    assert.deepEqual(subjects(sourceReasons(undefined, provenance)), ['ARTIFACT_MISSING:execution_manifest']);
    const missing = sourceReasons(manifest, undefined);
    assert.deepEqual(subjects(missing), ['ARTIFACT_MISSING:source_provenance']);
    assert.equal(missing[0]?.artifact_path, EXECUTION_PATHS.sourceProvenance);
  });

  it('names every field that differs from the manifest', () => {
    const other: FrozenRecord<SourceProvenance> = {
      ref: { ...provenance.ref, artifact_sha256: OTHER },
      record: { ...provenance.record, commit_sha: '0'.repeat(40), tree_sha: '1'.repeat(40) },
    };
    const reasons = sourceReasons(manifest, other);
    assert.deepEqual(subjects(reasons), [
      'SOURCE_NOT_CLEAN:source_provenance_sha256',
      'SOURCE_NOT_CLEAN:commit_sha',
      'SOURCE_NOT_CLEAN:tree_sha',
    ]);
    assert.match(reasons[1]?.detail ?? '', /gives commit_sha 0{40}; the execution manifest froze [0-9a-f]{40}$/);
  });
});

describe('qualificationReasons', () => {
  it('is empty for the selected qualification', () => {
    assert.deepEqual(qualificationReasons(manifest, BASE_QUALIFICATION), []);
  });

  it('names a missing manifest, an unselected qualification or a manifest without one', () => {
    assert.deepEqual(subjects(qualificationReasons(undefined, BASE_QUALIFICATION)), [
      'ARTIFACT_MISSING:execution_manifest',
    ]);
    const unselected = qualificationReasons(manifest, undefined);
    assert.deepEqual(subjects(unselected), ['QUALIFICATION_MISMATCH:qualification']);
    assert.match(unselected[0]?.detail ?? '', /^no transport qualification was selected;/);
    const path = EXECUTION_PATHS.executionManifest;
    const probe = readRecordFile(new Map([[path, probeManifestBytes()]]), path, 'execution_manifest', READ_DEPS);
    assert.ok(probe.status === 'read' && probe.frozen.record.qualification === null);
    const none = qualificationReasons(probe.frozen, BASE_QUALIFICATION);
    assert.match(none[0]?.detail ?? '', /^the execution manifest names no qualification;/);
  });

  it('names every field that differs from the selection', () => {
    const selected = {
      qualification: {
        transport_probe_id: '00000000-0000-4000-8000-000000000009',
        original_package_index_sha256: OTHER,
        amendment_head_sha256: OTHER,
      },
      transport_scope_snapshot_sha256: OTHER,
    } as const;
    const reasons = qualificationReasons(manifest, {
      ...selected,
      qualification: {
        ...selected.qualification,
        transport_probe_id: selected.qualification.transport_probe_id as never,
      },
    });
    assert.deepEqual(subjects(reasons), [
      'QUALIFICATION_MISMATCH:transport_probe_id',
      'QUALIFICATION_MISMATCH:original_package_index_sha256',
      'QUALIFICATION_MISMATCH:amendment_head_sha256',
      'QUALIFICATION_MISMATCH:transport_scope_snapshot_sha256',
    ]);
    assert.match(reasons[2]?.detail ?? '', /froze amendment_head_sha256 null; the selected qualification has f{64}$/);
    assert.ok(reasons.every((reason) => reason.artifact_path === EXECUTION_PATHS.executionManifest));
  });
});
