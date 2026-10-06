// BR-RUA-028 / AC-RUA-051: any difference between the selected probe's snapshot and the
// snapshot recomputed from committed source is scoped drift; identical snapshots are not.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Sha256Hex } from '../../../../src/record-contract/primitives.ts';
import type { TransportScopeSnapshot } from '../../../../src/record-contract/records/group-a/transport_scope_snapshot.ts';
import { compareScopeSnapshots } from '../../../../src/transport-qualification/scope/scope-drift.ts';
import type {
  ScopeDriftAssessment,
  ScopeDriftItem,
} from '../../../../src/transport-qualification/scope/scope-drift.ts';
import { scopeSnapshotSha256 } from '../../../../src/transport-qualification/scope/scope-snapshot.ts';
import { CLIENT_SOURCE, CLIENT_TIMING_FILE } from './support/scope-fixtures.ts';
import { baseSnapshot } from './support/snapshot-samples.ts';

const SHA_A = 'a'.repeat(64) as Sha256Hex;
const SHA_B = 'b'.repeat(64) as Sha256Hex;
const TIMEOUT_31 = { property_values: [{ property_path: 'Properties.Timeout', canonical_json: '31' }] } as const;

function driftItems(assessment: ScopeDriftAssessment): readonly ScopeDriftItem[] {
  assert.ok(assessment.status === 'drift');
  return assessment.items;
}

const base = baseSnapshot();

describe('compareScopeSnapshots: no drift', () => {
  it('reports no drift with the shared digest when the snapshots are identical', () => {
    assert.deepEqual(compareScopeSnapshots(base, structuredClone(base)), {
      status: 'no_drift',
      snapshot_sha256: scopeSnapshotSha256(base),
    });
  });
});

describe('compareScopeSnapshots: itemized drift', () => {
  it('names a changed policy digest', () => {
    assert.deepEqual(driftItems(compareScopeSnapshots(base, { ...base, policy_sha256: SHA_A })), [
      { code: 'SCOPE_POLICY_CHANGED', subject: 'policy_sha256', selected: base.policy_sha256, recomputed: SHA_A },
    ]);
  });

  it('names changed entry points', () => {
    const entryPoints = ['src/other.handler.ts'] as const;
    assert.deepEqual(driftItems(compareScopeSnapshots(base, { ...base, entry_points: entryPoints })), [
      {
        code: 'SCOPE_ENTRY_POINTS_CHANGED',
        subject: 'entry_points',
        selected: base.entry_points,
        recomputed: entryPoints,
      },
    ]);
  });

  it('names each changed, added and removed scoped source file by path', () => {
    const [client, timing, ...rest] = base.source_files;
    assert.equal(client.path, CLIENT_SOURCE);
    assert.equal(timing?.path, CLIENT_TIMING_FILE);
    const recomputed: TransportScopeSnapshot = {
      ...base,
      source_files: [
        { path: CLIENT_SOURCE, sha256: SHA_A },
        ...rest,
        { path: 'src/provider-client/zz-new.ts', sha256: SHA_B },
      ],
    };
    assert.deepEqual(driftItems(compareScopeSnapshots(base, recomputed)), [
      { code: 'SCOPED_SOURCE_CHANGED', subject: CLIENT_SOURCE, selected: client.sha256, recomputed: SHA_A },
      { code: 'SCOPED_SOURCE_CHANGED', subject: CLIENT_TIMING_FILE, selected: timing.sha256, recomputed: null },
      { code: 'SCOPED_SOURCE_CHANGED', subject: 'src/provider-client/zz-new.ts', selected: null, recomputed: SHA_B },
    ]);
  });

  it('names a dependency by package with every resolved version on each side', () => {
    const recomputed: TransportScopeSnapshot = {
      ...base,
      dependency_closure: [
        { name: '@inner/helper', version: '2.0.0' },
        { name: '@scope/declared-dep', version: '4.1.0' },
        { name: 'fresh-dep', version: '0.0.1' },
        { name: 'transport-dep', version: '1.1.0' },
        { name: 'transport-dep', version: '1.0.0' },
      ],
    };
    assert.deepEqual(driftItems(compareScopeSnapshots(base, recomputed)), [
      { code: 'SCOPED_DEPENDENCY_CHANGED', subject: 'fresh-dep', selected: null, recomputed: ['0.0.1'] },
      {
        code: 'SCOPED_DEPENDENCY_CHANGED',
        subject: 'transport-dep',
        selected: ['1.0.0'],
        recomputed: ['1.0.0', '1.1.0'],
      },
    ]);
  });

  it('names a changed scoped lockfile digest', () => {
    assert.deepEqual(driftItems(compareScopeSnapshots(base, { ...base, lockfile_sha256: SHA_B })), [
      {
        code: 'SCOPED_LOCKFILE_CHANGED',
        subject: 'lockfile_sha256',
        selected: base.lockfile_sha256,
        recomputed: SHA_B,
      },
    ]);
  });

  it('names a changed or removed configuration projection by id', () => {
    const [functions, tables] = base.configuration_projections;
    assert.ok(tables !== undefined);
    const recomputed: TransportScopeSnapshot = {
      ...base,
      configuration_projections: [{ projection_id: functions.projection_id, resources: [TIMEOUT_31] }],
    };
    assert.deepEqual(driftItems(compareScopeSnapshots(base, recomputed)), [
      {
        code: 'SCOPED_CONFIGURATION_CHANGED',
        subject: 'experiment_core__functions',
        selected: functions.resources,
        recomputed: [TIMEOUT_31],
      },
      {
        code: 'SCOPED_CONFIGURATION_CHANGED',
        subject: 'experiment_core__tables',
        selected: tables.resources,
        recomputed: null,
      },
    ]);
  });

  it('names changed and added runtime properties', () => {
    const recomputed = {
      ...base,
      runtime_properties: { bundle_format: 'cjs', bundle_target: 'node24', bundle_aws_sdk: true },
    };
    assert.deepEqual(driftItems(compareScopeSnapshots(base, recomputed)), [
      { code: 'SCOPED_RUNTIME_PROPERTY_CHANGED', subject: 'bundle_aws_sdk', selected: null, recomputed: true },
      { code: 'SCOPED_RUNTIME_PROPERTY_CHANGED', subject: 'bundle_format', selected: 'esm', recomputed: 'cjs' },
    ]);
  });

  it('names a changed timing value', () => {
    const recomputed = { ...base, timing_values: { ...base.timing_values, provider_client_deadline_ms: 3001 } };
    assert.deepEqual(driftItems(compareScopeSnapshots(base, recomputed)), [
      { code: 'SCOPED_TIMING_CHANGED', subject: 'provider_client_deadline_ms', selected: 3000, recomputed: 3001 },
    ]);
  });

  it('names a changed provider warm-up policy', () => {
    const recomputed = { ...base, provider_warmup: { invocations_per_trial: 2 } } as unknown as TransportScopeSnapshot;
    assert.deepEqual(driftItems(compareScopeSnapshots(base, recomputed)), [
      {
        code: 'SCOPED_WARMUP_POLICY_CHANGED',
        subject: 'provider_warmup',
        selected: { invocations_per_trial: 1 },
        recomputed: { invocations_per_trial: 2 },
      },
    ]);
  });

  it('reports a difference no field names, such as a non-canonical order, as whole-snapshot drift', () => {
    const reordered: TransportScopeSnapshot = {
      ...base,
      source_files: [...base.source_files].reverse() as unknown as TransportScopeSnapshot['source_files'],
    };
    assert.deepEqual(compareScopeSnapshots(base, reordered), {
      status: 'drift',
      selected_sha256: scopeSnapshotSha256(base),
      recomputed_sha256: scopeSnapshotSha256(reordered),
      items: [
        {
          code: 'SCOPE_SNAPSHOT_CHANGED',
          subject: 'transport_scope_snapshot',
          selected: scopeSnapshotSha256(base),
          recomputed: scopeSnapshotSha256(reordered),
        },
      ],
      reasons: [
        {
          code: 'SCOPE_SNAPSHOT_CHANGED',
          subject: 'BR-RUA-028',
          detail:
            `transport_scope_snapshot: selected probe scope has "${scopeSnapshotSha256(base)}", current committed source has ` +
            `"${scopeSnapshotSha256(reordered)}"; expected identical scope, otherwise a new transport probe is required`,
        },
      ],
    });
  });
});

describe('compareScopeSnapshots: rejection reasons', () => {
  it('gives one BR-RUA-028 reason per item, in item order, naming both values', () => {
    const recomputed = { ...base, lockfile_sha256: SHA_B, policy_sha256: SHA_A };
    const assessment = compareScopeSnapshots(base, recomputed);
    assert.ok(assessment.status === 'drift');
    assert.equal(assessment.selected_sha256, scopeSnapshotSha256(base));
    assert.equal(assessment.recomputed_sha256, scopeSnapshotSha256(recomputed));
    assert.deepEqual(assessment.reasons, [
      {
        code: 'SCOPE_POLICY_CHANGED',
        subject: 'BR-RUA-028',
        detail:
          `policy_sha256: selected probe scope has "${base.policy_sha256}", current committed source has "${SHA_A}"; ` +
          'expected identical scope, otherwise a new transport probe is required',
      },
      {
        code: 'SCOPED_LOCKFILE_CHANGED',
        subject: 'BR-RUA-028',
        detail:
          `lockfile_sha256: selected probe scope has "${base.lockfile_sha256}", current committed source has "${SHA_B}"; ` +
          'expected identical scope, otherwise a new transport probe is required',
      },
    ]);
  });
});
