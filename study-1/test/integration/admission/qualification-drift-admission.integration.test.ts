// AC-RUA-051 — Qualification Drift Is Refused, admission case (BR-RUA-028; design §10.1 A13,
// §14 row 051). WP-11 proves the drift decision over a real repository and esbuild; this proves
// what admission does with it: a run that selected a usable probe recomputes the transport scope
// from the committed source at admission, and any scoped drift rejects the attempt before the
// manifest freezes (QUALIFICATION, no package written), while a change outside the scope, such
// as an oracle module, leaves the qualification valid and the run admitted with the selected
// probe's snapshot.
//
// Boundary: the production `admitExecution`, `recomputeScopeSnapshot` and `compareScopeSnapshots`
// over the WP-11 named fakes of the committed tree, the bundler and `node_modules`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { isJsonObject } from '../../../src/record-contract/json-value.ts';
import { parseJsonDocument } from '../../../src/record-contract/parsing.ts';
import { PACKAGE_LOCK_PATH } from '../../../src/transport-qualification/scope/package-lock.ts';
import { AdmissionHarness } from '../../support/admission/admission-harness.ts';
import {
  CLIENT_SOURCE,
  ORACLE_SOURCE,
  SAMPLE_LOCK_ENTRIES,
  lockEntry,
  lockfileJson,
} from '../../unit/transport-qualification/scope/support/scope-fixtures.ts';

async function assertDriftRejected(harness: AdmissionHarness): Promise<readonly string[]> {
  const outcome = await harness.admit();
  assert.equal(outcome.kind, 'rejected', JSON.stringify(outcome));
  const rejection = await harness.rejection(outcome.admission_attempt_id);
  assert.ok(rejection !== undefined && isJsonObject(rejection));
  assert.equal(rejection['rejection_class'], 'QUALIFICATION');
  assert.equal(rejection['failed_check_id'], 'A13');
  assert.deepEqual(await harness.packagePaths(), [], 'the manifest never freezes');
  assert.equal(harness.mutationLog.isEmpty(), true);
  return outcome.reasons.map((reason) => reason.code);
}

describe('AC-RUA-051 admission refuses qualification drift', () => {
  it('scoped-source-change', async () => {
    const harness = await AdmissionHarness.create('RUN');
    harness.sources.commit(CLIENT_SOURCE, "export const client = 'v2';\n");
    const codes = await assertDriftRejected(harness);
    assert.deepEqual(codes, ['SCOPED_SOURCE_CHANGED']);
  });

  it('scoped-dependency-change', async () => {
    const harness = await AdmissionHarness.create('VARIANT_VALIDATION');
    const entries = { ...SAMPLE_LOCK_ENTRIES, 'node_modules/transport-dep': lockEntry('transport-dep', '1.0.1') };
    harness.sources.commit(PACKAGE_LOCK_PATH, lockfileJson(entries));
    harness.installed.install('node_modules/transport-dep', '1.0.1');
    const codes = await assertDriftRejected(harness);
    assert.deepEqual(codes, ['SCOPED_DEPENDENCY_CHANGED', 'SCOPED_LOCKFILE_CHANGED']);
  });

  it('unrelated-oracle-change', async () => {
    const harness = await AdmissionHarness.create('RUN');
    harness.sources.commit(ORACLE_SOURCE, "export const oracle = 'v2';\n");
    const outcome = await harness.admit();
    assert.equal(outcome.kind, 'admitted', JSON.stringify(outcome));
    const manifest = parseJsonDocument(await harness.evidenceFile(outcome.manifest_path));
    assert.ok(manifest.ok && isJsonObject(manifest.value));
    assert.equal(manifest.value['transport_scope_snapshot_sha256'], harness.selected?.snapshot_sha256);
    const directory = outcome.manifest_path.slice(0, -EXECUTION_PATHS.executionManifest.length);
    const stored = await harness.evidenceFile(`${directory}${EXECUTION_PATHS.transportScopeSnapshot}`);
    assert.deepEqual(parseJsonDocument(stored), { ok: true, value: harness.selected?.snapshot });
  });
});
