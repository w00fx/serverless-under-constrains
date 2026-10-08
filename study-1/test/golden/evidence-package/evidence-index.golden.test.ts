// AC-RUA-010 golden (BR-RUA-008, BR-RUA-035, BR-RUA-037, BR-RUA-043, BR-RUA-044): the evidence
// index of the canonical run's Durable COMMIT_THEN_TIMEOUT trial, built from the committed fixture
// of each case under cases/ (materialized by tools/golden/generate-fixtures.ts, design §12.4).
// The classes, derivations and exclusions each case expects are written from the design §7 layout
// and the §6.2 catalogue kinds (support/frozen-trial-package.ts). The byte counts and SHA-256
// digests are computed here with node:crypto over the committed bytes, independently of the kernel
// digest the index builder uses, so "indexed by exact bytes" is checked against the stored files.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { TRIAL_CORE_PATHS, buildEvidenceIndex } from '../../../src/evidence-package/evidence-index.ts';
import { expectedArtifactsFor } from '../../../src/evidence-package/expected-artifacts.ts';
import type { PackageFile } from '../../../src/evidence-package/package-file-system.ts';
import { isJsonArray, isJsonObject } from '../../../src/record-contract/json-value.ts';
import type { JsonObject, JsonValue, UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { TrialManifest } from '../../../src/record-contract/records/group-a/trial_manifest.ts';
import type { EvidenceIndex } from '../../../src/record-contract/records/group-c/evidence_index.ts';
import type { IndexEntry } from '../../../src/record-contract/records/group-c/shared-shapes.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { expandSubjectAlias } from '../../support/golden-builder/scenario-operations.ts';
import { fixtureRecords, loadGoldenCase } from '../_harness/golden-harness.ts';
import type { LoadedGoldenCase } from '../_harness/golden-harness.ts';

const CREATED_AT = '2026-10-05T12:30:00.000Z' as UtcMillis;
const validator = createRecordValidator();

async function loadCase(caseId: string): Promise<LoadedGoldenCase> {
  return loadGoldenCase(`test/golden/evidence-package/cases/${caseId}.case.ts`);
}

function packageFiles(loaded: LoadedGoldenCase): readonly PackageFile[] {
  return [...loaded.files].map(([path, bytes]) => ({ path, bytes }));
}

function storedBytes(loaded: LoadedGoldenCase, path: string): Uint8Array {
  const bytes = loaded.files.get(path);
  assert.ok(bytes !== undefined, `the fixture holds ${path}`);
  return bytes;
}

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function subjectManifest(loaded: LoadedGoldenCase): TrialManifest {
  const [manifest] = fixtureRecords(loaded.files, `${loaded.subject_directory}/trial-manifest.json`);
  assert.ok(manifest?.['record_type'] === 'trial_manifest', 'the subject directory holds its trial manifest');
  // The base fixture is schema-valid (the harness base golden checks it), so it is a trial manifest.
  return manifest as unknown as TrialManifest;
}

function subjectIndex(loaded: LoadedGoldenCase): EvidenceIndex {
  const manifest = subjectManifest(loaded);
  const runId = manifest.run_id;
  assert.ok(runId !== undefined, 'the subject trial belongs to a run');
  const built = buildEvidenceIndex({
    files: packageFiles(loaded),
    target: {
      index_scope: 'TRIAL',
      execution: { execution_kind: 'RUN', run_id: runId },
      trial_id: manifest.trial_id,
    },
    created_at: CREATED_AT,
  });
  assert.ok(built.ok, JSON.stringify(built));
  return built.value;
}

function expectedMember(loaded: LoadedGoldenCase, key: string): JsonValue {
  const { expected } = loaded.golden_case;
  assert.ok(isJsonObject(expected) && Object.hasOwn(expected, key), `the case expects ${key}`);
  return (expected as JsonObject)[key] as JsonValue;
}

function expectedStrings(loaded: LoadedGoldenCase, key: string): readonly string[] {
  const value = expectedMember(loaded, key);
  assert.ok(isJsonArray(value) && value.every((item) => typeof item === 'string'), `${key} lists paths`);
  return value;
}

// The expected rows of a case with the stored files' byte counts and digests, sorted by path in
// UTF-16 code units as every index is (the catalogue's `x-rua-evidence-ref-order`).
function expectedEntries(loaded: LoadedGoldenCase): readonly IndexEntry[] {
  const rows = expectedMember(loaded, 'rows');
  assert.ok(isJsonArray(rows), 'rows is an array');
  return rows
    .map((row) => {
      assert.ok(isJsonObject(row), 'each row is an object');
      const artifactPath = row['artifact_path'];
      assert.ok(typeof artifactPath === 'string', 'each row names its artifact path');
      const path = expandSubjectAlias(artifactPath, loaded.subject_directory);
      const bytes = storedBytes(loaded, path);
      return {
        artifact_path: path,
        artifact_class: row['artifact_class'],
        derivation: row['derivation'],
        bytes: bytes.length,
        sha256: sha256Of(bytes),
      } as IndexEntry;
    })
    .toSorted((a, b) => (a.artifact_path < b.artifact_path ? -1 : 1));
}

const primaryCase = await loadCase('ac010-primary-classes-exact-bytes');
const derivedCase = await loadCase('ac010-derived-flagged');
const exclusionCase = await loadCase('ac010-excludes-self-and-late-evidence');

describe('AC-RUA-010 evidence index of a Durable run trial', () => {
  it('ac010-primary-classes-exact-bytes', () => {
    const index = subjectIndex(primaryCase);
    const manifest = subjectManifest(primaryCase);
    const { entries, ...header } = index;
    assert.deepEqual(header, {
      schema_version: 1,
      record_type: 'evidence_index',
      run_id: manifest.run_id,
      execution_manifest_sha256: sha256Of(storedBytes(primaryCase, 'admission/execution-manifest.json')),
      trial_id: manifest.trial_id,
      trial_manifest_sha256: sha256Of(storedBytes(primaryCase, `${primaryCase.subject_directory}/trial-manifest.json`)),
      index_scope: expectedMember(primaryCase, 'index_scope'),
      created_at: CREATED_AT,
    });
    assert.deepEqual(
      entries.filter((entry) => entry.derivation === 'primary'),
      expectedEntries(primaryCase),
    );
    assert.ok(validator.validateAs('evidence_index', JSON.parse(JSON.stringify(index)) as JsonValue).valid);
    // Every artifact the oracle expects inside the index scope (the trial directory and the
    // execution-level core files) is indexed. The runner journal is expected too, but it stays open
    // across trials, so the final package index hashes it, not the trial's evidence index.
    const indexed = new Set(entries.map((entry) => entry.artifact_path));
    const inScope = expectedArtifactsFor(manifest).filter(
      (artifact) =>
        artifact.path.startsWith(`${primaryCase.subject_directory}/`) || TRIAL_CORE_PATHS.includes(artifact.path),
    );
    assert.equal(inScope.length, 18);
    assert.deepEqual(
      inScope.filter((artifact) => !indexed.has(artifact.path)),
      [],
    );
  });

  it('ac010-derived-flagged', () => {
    const { entries } = subjectIndex(derivedCase);
    assert.deepEqual(
      entries.filter((entry) => entry.derivation === 'derived'),
      expectedEntries(derivedCase),
    );
    const primaryCount = entries.filter((entry) => entry.derivation === 'primary').length;
    assert.equal(primaryCount, expectedMember(derivedCase, 'primary_count'));
    // Every entry is one or the other: nothing is left unflagged.
    assert.equal(primaryCount + expectedEntries(derivedCase).length, entries.length);
  });

  it('ac010-excludes-self-and-late-evidence', () => {
    const { entries } = subjectIndex(exclusionCase);
    const paths = entries.map((entry) => entry.artifact_path);
    const stored = [...exclusionCase.files.keys()];
    for (const excluded of expectedStrings(exclusionCase, 'excluded')) {
      const path = expandSubjectAlias(excluded, exclusionCase.subject_directory);
      assert.ok(stored.includes(path), `the fixture holds ${path}`);
      assert.equal(paths.includes(path), false, `${path} is indexed`);
    }
    for (const prefix of expectedStrings(exclusionCase, 'excluded_prefixes')) {
      assert.ok(
        stored.some((path) => path.startsWith(prefix)),
        `the fixture holds files under ${prefix}`,
      );
      assert.deepEqual(
        paths.filter((path) => path.startsWith(prefix)),
        [],
      );
    }
    assert.equal(entries.length, expectedMember(exclusionCase, 'entry_count'));
    // The scope is exactly the subject directory, without its own index, plus the core files.
    const selfIndex = `${exclusionCase.subject_directory}/evidence-index.json`;
    const scope = stored.filter(
      (path) =>
        (path.startsWith(`${exclusionCase.subject_directory}/`) && path !== selfIndex) ||
        TRIAL_CORE_PATHS.includes(path),
    );
    assert.deepEqual(
      paths,
      scope.toSorted((a, b) => (a < b ? -1 : 1)),
    );
  });
});
