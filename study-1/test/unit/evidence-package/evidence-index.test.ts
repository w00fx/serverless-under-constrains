// The evidence index of one trial or of the probe (BR-RUA-043, BR-RUA-044, AC-RUA-010; design §7):
// it hashes the unit's files and the execution-level core files by exact bytes, excludes itself,
// the late-evidence area and every other trial, and fails instead of indexing an incomplete or
// unclassifiable set. The golden AC-RUA-010 cases are in test/golden/evidence-package/.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PROBE_CORE_PATHS,
  TRIAL_CORE_PATHS,
  buildEvidenceIndex,
  unitOf,
} from '../../../src/evidence-package/evidence-index.ts';
import type { EvidenceIndexTarget } from '../../../src/evidence-package/evidence-index.ts';
import type { PackageFile } from '../../../src/evidence-package/package-file-system.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { PROBE_ID, RUN_ID, TRIAL_ID, VALIDATION_ID, at, uuid } from '../../support/record-contract/record-builders.ts';
import { reasonCodes, textFile } from '../../support/evidence-package/package-files.ts';

const validator = createRecordValidator();
const TRIAL_DIR = `trials/${TRIAL_ID}`;
const RUN_TARGET: EvidenceIndexTarget = {
  index_scope: 'TRIAL',
  execution: { execution_kind: 'RUN', run_id: RUN_ID },
  trial_id: TRIAL_ID,
};

function coreFiles(paths: readonly string[]): readonly PackageFile[] {
  return paths.map((path) => textFile(path, `{"core":${JSON.stringify(path)}}\n`));
}

function trialFiles(): readonly PackageFile[] {
  return [
    ...coreFiles(TRIAL_CORE_PATHS),
    textFile(`${TRIAL_DIR}/trial-manifest.json`, '{"trial":1}\n'),
    textFile(`${TRIAL_DIR}/inputs/payment.json`, '{"payment":1}\n'),
    textFile(`${TRIAL_DIR}/journals/controller-journal.jsonl`, ''),
    textFile(`${TRIAL_DIR}/derived/oracle-result.json`, '{"oracle":1}\n'),
  ];
}

describe('buildEvidenceIndex', () => {
  it('indexes a run trial with its manifest digests and a schema-valid record', () => {
    const files = trialFiles();
    const built = buildEvidenceIndex({ files, target: RUN_TARGET, created_at: at(1) });
    assert.ok(built.ok);
    const index = built.value;
    assert.equal(index.index_scope, 'TRIAL');
    assert.equal(index.execution_manifest_sha256, sha256Hex(files[0]?.bytes ?? new Uint8Array()));
    assert.equal(index.trial_manifest_sha256, sha256Hex(textFile('x', '{"trial":1}\n').bytes));
    assert.equal(index.entries.length, files.length);
    const empty = index.entries.find((entry) => entry.artifact_path.endsWith('controller-journal.jsonl'));
    assert.deepEqual([empty?.bytes, empty?.sha256], [0, sha256Hex(new Uint8Array())]);
    assert.ok(validator.validateAs('evidence_index', JSON.parse(JSON.stringify(index)) as never).valid);
  });

  it('names the variant validation of a validation trial', () => {
    const target: EvidenceIndexTarget = {
      index_scope: 'TRIAL',
      execution: { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: VALIDATION_ID },
      trial_id: TRIAL_ID,
    };
    const built = buildEvidenceIndex({ files: trialFiles(), target, created_at: at(1) });
    assert.ok(built.ok);
    assert.equal(Object.hasOwn(built.value, 'run_id'), false);
    assert.ok(validator.validateAs('evidence_index', JSON.parse(JSON.stringify(built.value)) as never).valid);
  });

  it('excludes itself, the late-evidence area, other trials and non-core execution files', () => {
    const files = [
      ...trialFiles(),
      textFile(`${TRIAL_DIR}/evidence-index.json`, '{"stale":true}\n'),
      textFile('late-evidence/late-evidence-stream.jsonl', '{"late":1}\n'),
      textFile(`trials/${uuid(0x999)}/inputs/payment.json`, '{"other":1}\n'),
      textFile('runner/runner-journal.jsonl', ''),
      textFile('notes.txt', 'outside the layout but outside the scope too'),
    ];
    const built = buildEvidenceIndex({ files, target: RUN_TARGET, created_at: at(1) });
    assert.ok(built.ok);
    assert.deepEqual(
      built.value.entries.map((entry) => entry.artifact_path),
      trialFiles()
        .map((file) => file.path)
        .toSorted(),
    );
  });

  it('indexes the probe with the prefix checkpoint and no trial manifest', () => {
    const files = [...coreFiles(PROBE_CORE_PATHS), textFile('probe/ledger/ledger-snapshot.json', '{}\n')];
    const built = buildEvidenceIndex({
      files,
      target: { index_scope: 'PROBE', transport_probe_id: PROBE_ID },
      created_at: at(2),
    });
    assert.ok(built.ok);
    assert.equal(built.value.index_scope, 'PROBE');
    assert.equal(Object.hasOwn(built.value, 'trial_manifest_sha256'), false);
    assert.ok(built.value.entries.some((entry) => entry.artifact_class === 'coordination_prefix_checkpoint'));
    assert.ok(validator.validateAs('evidence_index', JSON.parse(JSON.stringify(built.value)) as never).valid);
  });

  it('reports every missing core file and a missing trial manifest', () => {
    const files = trialFiles().filter(
      (file) =>
        ![
          'admission/execution-manifest.json',
          'admission/source-provenance.json',
          `${TRIAL_DIR}/trial-manifest.json`,
        ].includes(file.path),
    );
    const built = buildEvidenceIndex({ files, target: RUN_TARGET, created_at: at(1) });
    assert.ok(!built.ok);
    assert.deepEqual(
      built.error.map((reason) => [reason.code, reason.artifact_path]),
      [
        ['CORE_FILE_MISSING', 'admission/source-provenance.json'],
        ['CORE_FILE_MISSING', 'admission/execution-manifest.json'],
        ['CORE_FILE_MISSING', `${TRIAL_DIR}/trial-manifest.json`],
      ],
    );
  });

  it('reports a missing probe core file', () => {
    const built = buildEvidenceIndex({
      files: coreFiles(TRIAL_CORE_PATHS),
      target: { index_scope: 'PROBE', transport_probe_id: PROBE_ID },
      created_at: at(2),
    });
    assert.ok(!built.ok);
    assert.deepEqual(reasonCodes(built.error), ['CORE_FILE_MISSING']);
  });

  it('refuses invalid and duplicate paths before reading anything', () => {
    const built = buildEvidenceIndex({
      files: [...trialFiles(), textFile('../escape.json', '{}'), textFile(`${TRIAL_DIR}/inputs/payment.json`, '{}')],
      target: RUN_TARGET,
      created_at: at(1),
    });
    assert.ok(!built.ok);
    assert.deepEqual(reasonCodes(built.error), ['DUPLICATE_ARTIFACT_PATH', 'INVALID_ARTIFACT_PATH']);
  });

  it('fails on an unclassifiable file inside the trial directory', () => {
    const built = buildEvidenceIndex({
      files: [...trialFiles(), textFile(`${TRIAL_DIR}/scratch/notes.txt`, 'x')],
      target: RUN_TARGET,
      created_at: at(1),
    });
    assert.ok(!built.ok);
    assert.deepEqual(reasonCodes(built.error), ['UNCLASSIFIABLE_ARTIFACT_PATH']);
  });

  it('maps a target to its unit directory', () => {
    assert.deepEqual(unitOf(RUN_TARGET), { kind: 'trial', trial_id: TRIAL_ID });
    assert.deepEqual(unitOf({ index_scope: 'PROBE', transport_probe_id: PROBE_ID }), { kind: 'probe' });
  });
});
