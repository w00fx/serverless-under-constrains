// AC-RUA-010 golden (BR-RUA-008, BR-RUA-035, BR-RUA-037, BR-RUA-043): the evidence index of a
// Durable `COMMIT_THEN_TIMEOUT` trial of a run, generated from the handcrafted package tree in
// fixtures/durable-run-trial/package/, equals fixtures/durable-run-trial/expected-evidence-index.json
// byte for byte. The expected file is the oracle: its classes and derivations were written from
// the design §7 layout, and every byte count and SHA-256 was computed with `wc -c` and
// `shasum -a 256` over the fixture files, not by the code under test.
//
// The tree also holds what the index must leave out: a stale `evidence-index.json` of the trial
// itself, the late-evidence area, another trial, the runner and execution-level provider journals,
// and the run summary.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TRIAL_CORE_PATHS, buildEvidenceIndex } from '../../../src/evidence-package/evidence-index.ts';
import { expectedArtifactsFor } from '../../../src/evidence-package/expected-artifacts.ts';
import type { PackageFile } from '../../../src/evidence-package/package-file-system.ts';
import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import type { UtcMillis, Uuid4 } from '../../../src/record-contract/primitives.ts';
import type { EvidenceIndex } from '../../../src/record-contract/records/group-c/evidence_index.ts';
import type { IndexEntry } from '../../../src/record-contract/records/group-c/shared-shapes.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { trialManifest } from '../../contract/record-contract/group-a/support/manifest-examples.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/durable-run-trial/', import.meta.url));
const PACKAGE_ROOT = join(FIXTURE, 'package');
const RUN_ID = '00000000-0000-4000-8000-000000000100' as Uuid4;
const TRIAL_ID = '00000000-0000-4000-8000-000000000103' as Uuid4;
const TRIAL_DIR = `trials/${TRIAL_ID}`;
const CREATED_AT = '2026-10-05T12:30:00.000Z' as UtcMillis;

/** The primary classes AC-RUA-010 names for a Durable trial with a DLQ snapshot. */
const PRIMARY_CLASSES = [
  'approved_decision',
  'caller_journal',
  'controller_journal',
  'deployment_assembly_inventory',
  'dlq_observations',
  'dlq_snapshot',
  'durable_execution_metadata',
  'environment_input',
  'execution_manifest',
  'ledger_snapshot',
  'oracle_revision_check',
  'payment',
  'provider_journal',
  'provider_trial_configuration',
  'published_message',
  'resource_manifest',
  'settlement_samples',
  'source_observations',
  'source_provenance',
  'telemetry_availability',
  'treatment_state_snapshot',
  'trial_manifest',
  'trial_registration',
];

function fixtureFiles(): readonly PackageFile[] {
  return readdirSync(PACKAGE_ROOT, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const absolute = join(entry.parentPath, entry.name);
      return {
        path: relative(PACKAGE_ROOT, absolute).split(sep).join('/'),
        bytes: new Uint8Array(readFileSync(absolute)),
      };
    });
}

function generated(): EvidenceIndex {
  const built = buildEvidenceIndex({
    files: fixtureFiles(),
    target: { index_scope: 'TRIAL', execution: { execution_kind: 'RUN', run_id: RUN_ID }, trial_id: TRIAL_ID },
    created_at: CREATED_AT,
  });
  assert.ok(built.ok, JSON.stringify(built));
  return built.value;
}

function expectedBytes(): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE, 'expected-evidence-index.json')));
}

function expectedEntries(): readonly IndexEntry[] {
  return (JSON.parse(new TextDecoder().decode(expectedBytes())) as EvidenceIndex).entries;
}

describe('AC-RUA-010 evidence index of a Durable run trial', () => {
  it('ac010-primary-classes-exact-bytes', () => {
    const index = generated();
    assert.deepEqual(serializeRecordFile(index), expectedBytes());
    const primary = index.entries.filter((entry) => entry.derivation === 'primary');
    assert.deepEqual(primary.map((entry) => entry.artifact_class).toSorted(), PRIMARY_CLASSES);
    const empty = index.entries.find((entry) => entry.artifact_class === 'controller_journal');
    assert.deepEqual(
      [empty?.bytes, empty?.sha256],
      [0, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    );
    assert.ok(createRecordValidator().validateAs('evidence_index', JSON.parse(JSON.stringify(index)) as never).valid);
    // Every artifact the oracle expects inside the index scope (design §7: the trial directory and
    // the execution-level core files) is indexed. The runner journal is expected too, but it stays
    // open across trials, so the final package index hashes it, not the trial's evidence index.
    const manifest = { ...trialManifest(), trial_id: TRIAL_ID, variant_id: 'durable' as const };
    const indexed = new Set(index.entries.map((entry) => entry.artifact_path));
    const expected = expectedArtifactsFor(manifest).filter(
      (artifact) => artifact.path.startsWith(`${TRIAL_DIR}/`) || TRIAL_CORE_PATHS.includes(artifact.path),
    );
    assert.equal(expected.length, 18);
    assert.ok(
      expected.every((artifact) => indexed.has(artifact.path)),
      JSON.stringify(expected.filter((a) => !indexed.has(a.path))),
    );
  });

  it('ac010-derived-flagged', () => {
    const derived = generated().entries.filter((entry) => entry.derivation === 'derived');
    assert.deepEqual(
      derived.map((entry) => [entry.artifact_path, entry.artifact_class]),
      [
        [`${TRIAL_DIR}/derived/attempt-projection.json`, 'attempt_projection'],
        [`${TRIAL_DIR}/derived/oracle-result.json`, 'oracle_result'],
      ],
    );
    assert.deepEqual(
      derived,
      expectedEntries().filter((entry) => entry.derivation === 'derived'),
    );
  });

  it('ac010-excludes-self-and-late-evidence', () => {
    const paths = generated().entries.map((entry) => entry.artifact_path);
    const stored = fixtureFiles().map((file) => file.path);
    for (const excluded of [
      `${TRIAL_DIR}/evidence-index.json`,
      'late-evidence/late-evidence-stream.jsonl',
      'late-evidence/late-evidence-assessment.json',
      'trials/00000000-0000-4000-8000-000000000104/inputs/payment.json',
      'runner/runner-journal.jsonl',
      'provider/provider-journal.jsonl',
      'summary/run-summary.json',
    ]) {
      assert.ok(stored.includes(excluded), `the fixture holds ${excluded}`);
      assert.equal(paths.includes(excluded), false, `${excluded} is indexed`);
    }
    assert.ok(paths.every((path) => !path.startsWith('late-evidence/')));
  });
});
