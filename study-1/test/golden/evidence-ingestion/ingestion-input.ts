// Turns a fixture tree into an ingestion input: the subject trial's files and the execution-level
// files are the artifacts (the expected set marks which are expected), and every other trial
// directory is the execution scope (INV-RUA-001). The expected set comes from the subject's frozen
// trial manifest through evidence-package's `expectedArtifactsFor`, as the production caller
// builds it. The unit suites reuse it over in-memory fixtures.

import { expectedArtifactsFor } from '../../../src/evidence-package/expected-artifacts.ts';
import type { IngestionInput, RawArtifact } from '../../../src/evidence-ingestion/ingestion-model.ts';
import type { TrialManifest } from '../../../src/record-contract/records/group-a/trial_manifest.ts';
import { fixtureRecords } from '../_harness/golden-harness.ts';
import type { LoadedGoldenCase } from '../_harness/golden-harness.ts';

/**
 * The ingestion input of a trial's fixture files.
 *
 * @example
 * ingestionInputFromFiles(materialized, 'trials/<trial_id>').expected.length; // 19
 */
export function ingestionInputFromFiles(
  files: ReadonlyMap<string, Uint8Array>,
  subjectDirectory: string,
): IngestionInput {
  const [manifest] = fixtureRecords(files, `${subjectDirectory}/trial-manifest.json`);
  if (manifest === undefined) {
    throw new Error(`${subjectDirectory}/trial-manifest.json is empty; expected one document`);
  }
  const artifacts: RawArtifact[] = [];
  const scope: RawArtifact[] = [];
  for (const [path, bytes] of [...files].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    const earlierTrial = path.startsWith('trials/') && !path.startsWith(`${subjectDirectory}/`);
    (earlierTrial ? scope : artifacts).push({ path, bytes });
  }
  return {
    artifacts,
    expected: expectedArtifactsFor(manifest as unknown as TrialManifest),
    execution_scope_artifacts: scope,
  };
}

/**
 * The ingestion input of a loaded trial case.
 *
 * @example
 * const input = ingestionInputOf(await loadGoldenCase('test/golden/evidence-ingestion/cases/sequence-gap.case.ts'));
 */
export function ingestionInputOf(loaded: LoadedGoldenCase): IngestionInput {
  return ingestionInputFromFiles(loaded.files, loaded.subject_directory);
}
