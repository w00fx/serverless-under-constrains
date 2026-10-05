// AC-RUA-051 — Qualification Drift Is Refused (BR-RUA-028).
// Given a selected transport probe, when admission recomputes its scope against current
// committed source, then any scoped drift rejects the attempt before manifest freeze, and
// unrelated oracle, reporting or orchestration changes do not require a new probe.
//
// Boundary (spec Verification: integration): a real temporary git repository, real esbuild
// metafile closures and the production adapters; the selected snapshot is the one computed
// at the probe's commit, the recomputed one at the later commit.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import type { TransportScopeSnapshot } from '../../../../src/record-contract/records/group-a/transport_scope_snapshot.ts';
import { createRecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import { SCOPE_BUNDLE_RUNTIME_PROPERTIES } from '../../../../src/transport-qualification/scope/bundle-inputs.ts';
import { EsbuildBundleInputResolver } from '../../../../src/transport-qualification/scope/node/esbuild-bundle-input-resolver.ts';
import { GitCommittedSourceReader } from '../../../../src/transport-qualification/scope/node/git-committed-source-reader.ts';
import { PACKAGE_LOCK_PATH } from '../../../../src/transport-qualification/scope/package-lock.ts';
import { compareScopeSnapshots } from '../../../../src/transport-qualification/scope/scope-drift.ts';
import { recomputeScopeSnapshot } from '../../../../src/transport-qualification/scope/scope-recomputation.ts';
import type { ScopeEnvironment } from '../../../../src/transport-qualification/scope/scope-recomputation.ts';
import { TRANSPORT_SCOPE_POLICY_PATH } from '../../../../src/transport-qualification/scope/scope-policy.ts';
import { scopeSnapshotSha256 } from '../../../../src/transport-qualification/scope/scope-snapshot.ts';
import {
  CLIENT_SOURCE,
  ORACLE_SOURCE,
  SAMPLE_TIMING,
  SHARED_PRIMITIVES,
  cdkTemplate,
} from '../../../unit/transport-qualification/scope/support/scope-fixtures.ts';
import { PROJECT_FILES, PROJECT_POLICY, installProjectPackages, projectLock } from './support/scope-project-files.ts';
import { TemporaryScopeProject } from './support/temporary-scope-project.ts';

const validator = createRecordValidator();
const ENVIRONMENT: ScopeEnvironment = {
  template: cdkTemplate(),
  runtime: SCOPE_BUNDLE_RUNTIME_PROPERTIES,
  timing: SAMPLE_TIMING,
  provider_warmup: { invocations_per_trial: 1 },
};

async function recompute(project: TemporaryScopeProject): Promise<TransportScopeSnapshot> {
  const result = await recomputeScopeSnapshot(ENVIRONMENT, {
    sources: new GitCommittedSourceReader({ projectRoot: project.projectRoot }),
    bundles: new EsbuildBundleInputResolver({ projectRoot: project.projectRoot }),
    validator,
  });
  assert.ok(result.ok, `expected a snapshot, got ${JSON.stringify(result)}`);
  return result.value;
}

function digestOf(text: string): string {
  return sha256Hex(new TextEncoder().encode(text));
}

describe('AC-RUA-051 qualification drift is refused', () => {
  let project: TemporaryScopeProject;
  let selected: TransportScopeSnapshot;

  beforeEach(async () => {
    project = TemporaryScopeProject.create(PROJECT_FILES);
    installProjectPackages(project);
    selected = await recompute(project);
  });

  afterEach(() => {
    project.dispose();
  });

  it('scoped-source-change', async () => {
    const edited = `${PROJECT_FILES[CLIENT_SOURCE] ?? ''}export const abortReason = 'TIMER';\n`;
    project.write(CLIENT_SOURCE, edited);
    project.commit('change the shared provider client');
    const drift = compareScopeSnapshots(selected, await recompute(project));
    assert.ok(drift.status === 'drift');
    assert.deepEqual(drift.items, [
      {
        code: 'SCOPED_SOURCE_CHANGED',
        subject: CLIENT_SOURCE,
        selected: digestOf(PROJECT_FILES[CLIENT_SOURCE] ?? ''),
        recomputed: digestOf(edited),
      },
    ]);
    assert.deepEqual(
      drift.reasons.map((reason) => [reason.code, reason.subject]),
      [['SCOPED_SOURCE_CHANGED', 'BR-RUA-028']],
    );
  });

  it('scoped-dependency-change', async () => {
    installProjectPackages(project, '1.1.0');
    project.write(PACKAGE_LOCK_PATH, projectLock('1.1.0'));
    project.commit('bump the transport dependency');
    const recomputed = await recompute(project);
    const drift = compareScopeSnapshots(selected, recomputed);
    assert.ok(drift.status === 'drift');
    assert.deepEqual(drift.items, [
      { code: 'SCOPED_DEPENDENCY_CHANGED', subject: 'transport-dep', selected: ['1.0.0'], recomputed: ['1.1.0'] },
      {
        code: 'SCOPED_LOCKFILE_CHANGED',
        subject: 'lockfile_sha256',
        selected: selected.lockfile_sha256,
        recomputed: recomputed.lockfile_sha256,
      },
    ]);
  });

  it('unrelated-oracle-change', async () => {
    project.write(ORACLE_SOURCE, (PROJECT_FILES[ORACLE_SOURCE] ?? '').replace(':v1', ':v2'));
    project.write(PACKAGE_LOCK_PATH, projectLock('1.0.0', '8.0.0'));
    project.commit('change the oracle and its reporting dependency');
    const recomputed = await recompute(project);
    assert.deepEqual(compareScopeSnapshots(selected, recomputed), {
      status: 'no_drift',
      snapshot_sha256: scopeSnapshotSha256(selected),
    });
  });
});

describe('AC-RUA-051 supplementary: what the recomputed scope binds', () => {
  let project: TemporaryScopeProject;

  beforeEach(() => {
    project = TemporaryScopeProject.create(PROJECT_FILES);
    installProjectPackages(project);
  });

  afterEach(() => {
    project.dispose();
  });

  it('binds the bundled closure, the conservative roots and the locked packages, never the oracle', async () => {
    const snapshot = await recompute(project);
    assert.deepEqual(
      snapshot.source_files.map((file) => file.path),
      [
        'src/provider-client/provider-client.ts',
        'src/provider-client/timing.json',
        'src/record-contract/primitives.ts',
        'src/refund-provider/refund-provider.handler.ts',
        'src/transport-probe-caller/transport-probe-caller.handler.ts',
      ],
    );
    assert.deepEqual(snapshot.dependency_closure, [
      { name: '@scope/declared-dep', version: '4.1.0' },
      { name: 'transport-dep', version: '1.0.0' },
    ]);
    assert.deepEqual(snapshot.runtime_properties, SCOPE_BUNDLE_RUNTIME_PROPERTIES);
    assert.deepEqual(
      validator.validateAs('transport_scope_snapshot', JSON.parse(JSON.stringify(snapshot)) as never).valid,
      true,
    );
  });

  it('treats a change to a shared module inside the closure as scoped drift', async () => {
    const selected = await recompute(project);
    project.write(SHARED_PRIMITIVES, "export const SHARED_MARKER = 'shared-v2';\n");
    project.commit('change a module the transport bundles');
    const drift = compareScopeSnapshots(selected, await recompute(project));
    assert.deepEqual(drift.status === 'drift' ? drift.items.map((item) => [item.code, item.subject]) : [], [
      ['SCOPED_SOURCE_CHANGED', SHARED_PRIMITIVES],
    ]);
  });

  it('treats a policy change as scoped drift', async () => {
    const selected = await recompute(project);
    project.write(
      TRANSPORT_SCOPE_POLICY_PATH,
      JSON.stringify({ ...PROJECT_POLICY, dependencies: ['@scope/declared-dep', 'reporting-dep'] }),
    );
    project.commit('widen the scope policy');
    const drift = compareScopeSnapshots(selected, await recompute(project));
    assert.deepEqual(drift.status === 'drift' ? drift.items.map((item) => [item.code, item.subject]) : [], [
      ['SCOPE_POLICY_CHANGED', 'policy_sha256'],
      ['SCOPED_DEPENDENCY_CHANGED', 'reporting-dep'],
      ['SCOPED_LOCKFILE_CHANGED', 'lockfile_sha256'],
    ]);
  });

  it('refuses to compute a scope when a transport import cannot be resolved', async () => {
    project.write(CLIENT_SOURCE, "import { gone } from './missing.ts';\nexport const client = gone;\n");
    project.commit('break the provider client');
    const result = await recomputeScopeSnapshot(ENVIRONMENT, {
      sources: new GitCommittedSourceReader({ projectRoot: project.projectRoot }),
      bundles: new EsbuildBundleInputResolver({ projectRoot: project.projectRoot }),
      validator,
    });
    assert.deepEqual(result.ok ? [] : result.error.map((reason) => reason.code), ['BUNDLE_RESOLUTION_FAILED']);
  });
});
