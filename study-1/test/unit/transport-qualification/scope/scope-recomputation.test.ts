// Recomputing the scope from committed source (BR-RUA-028): the policy and lockfile come from
// the committed tree, every scoped file is digested from committed bytes, and every failure is
// a structured qualification reason. Runs over the named fakes of the three read ports.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { createRecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import { PACKAGE_LOCK_PATH } from '../../../../src/transport-qualification/scope/package-lock.ts';
import { recomputeScopeSnapshot } from '../../../../src/transport-qualification/scope/scope-recomputation.ts';
import type { ScopeEnvironment } from '../../../../src/transport-qualification/scope/scope-recomputation.ts';
import { TRANSPORT_SCOPE_POLICY_PATH } from '../../../../src/transport-qualification/scope/scope-policy.ts';
import { computeScopeSnapshot } from '../../../../src/transport-qualification/scope/scope-snapshot.ts';
import { FixedBundleInputResolver } from './support/fixed-bundle-input-resolver.ts';
import { MemoryCommittedSourceReader } from './support/memory-committed-source-reader.ts';
import { MemoryInstalledPackageReader } from './support/memory-installed-package-reader.ts';
import {
  CLIENT_SOURCE,
  ORACLE_SOURCE,
  PROBE_HANDLER,
  SAMPLE_BUNDLES,
  SAMPLE_COMMITTED_FILES,
  SAMPLE_INSTALLED_VERSIONS,
  SAMPLE_LOCK_BYTES,
  SAMPLE_POLICY,
  SAMPLE_RUNTIME,
  SAMPLE_TIMING,
  cdkTemplate,
  policyBytes,
  sampleSnapshotInput,
} from './support/scope-fixtures.ts';

const validator = createRecordValidator();
const ENVIRONMENT: ScopeEnvironment = {
  template: cdkTemplate(),
  runtime: SAMPLE_RUNTIME,
  timing: SAMPLE_TIMING,
  provider_warmup: { invocations_per_trial: 1 },
};

function committedProject(): MemoryCommittedSourceReader {
  return new MemoryCommittedSourceReader({
    ...SAMPLE_COMMITTED_FILES,
    [TRANSPORT_SCOPE_POLICY_PATH]: policyBytes(),
    [PACKAGE_LOCK_PATH]: SAMPLE_LOCK_BYTES,
  });
}

function installedProject(): MemoryInstalledPackageReader {
  return new MemoryInstalledPackageReader(SAMPLE_INSTALLED_VERSIONS);
}

describe('recomputeScopeSnapshot', () => {
  it('computes the same snapshot as the pure computation over the committed inputs', async () => {
    const sources = committedProject();
    const bundles = new FixedBundleInputResolver(SAMPLE_BUNDLES);
    const recomputed = await recomputeScopeSnapshot(ENVIRONMENT, {
      sources,
      bundles,
      installed: installedProject(),
      validator,
    });
    assert.deepEqual(recomputed, computeScopeSnapshot(sampleSnapshotInput()));
    assert.deepEqual(bundles.requests(), [SAMPLE_POLICY.entry_points]);
  });

  it('reads the policy, the lockfile and each scoped file once, never an unrelated file', async () => {
    const sources = committedProject();
    await recomputeScopeSnapshot(ENVIRONMENT, {
      sources,
      bundles: new FixedBundleInputResolver(SAMPLE_BUNDLES),
      installed: installedProject(),
      validator,
    });
    const reads = sources.reads();
    assert.deepEqual(reads.slice(0, 2), [TRANSPORT_SCOPE_POLICY_PATH, PACKAGE_LOCK_PATH]);
    assert.equal(new Set(reads).size, reads.length);
    assert.equal(reads.includes(ORACLE_SOURCE), false);
    assert.equal(reads.includes(CLIENT_SOURCE), true);
  });

  it('reads the installed version of every closure package once, never an unrelated package', async () => {
    const installed = installedProject();
    await recomputeScopeSnapshot(ENVIRONMENT, {
      sources: committedProject(),
      bundles: new FixedBundleInputResolver(SAMPLE_BUNDLES),
      installed,
      validator,
    });
    assert.deepEqual(installed.reads(), [
      'node_modules/@scope/declared-dep',
      'node_modules/transport-dep',
      'node_modules/transport-dep/node_modules/@inner/helper',
    ]);
  });

  it('refuses a stale install of a bundled package (regression: verify/spec-r1-stale-install.log)', async () => {
    const installed = installedProject();
    installed.install('node_modules/transport-dep', '0.9.0');
    const recomputed = await recomputeScopeSnapshot(ENVIRONMENT, {
      sources: committedProject(),
      bundles: new FixedBundleInputResolver(SAMPLE_BUNDLES),
      installed,
      validator,
    });
    assert.deepEqual(recomputed.ok ? [] : recomputed.error.map((reason) => reason.code), [
      'DEPENDENCY_INSTALL_MISMATCH',
    ]);
  });

  it('never reads an installed package outside the project and reports it as unlocked', async () => {
    const installed = installedProject();
    const bundles = [
      {
        ...SAMPLE_BUNDLES[0],
        entry_point: PROBE_HANDLER,
        local_sources: [PROBE_HANDLER],
        packages: ['../node_modules/x'],
      },
    ];
    const recomputed = await recomputeScopeSnapshot(ENVIRONMENT, {
      sources: committedProject(),
      bundles: new FixedBundleInputResolver([...bundles, ...SAMPLE_BUNDLES.slice(1)]),
      installed,
      validator,
    });
    assert.equal(installed.reads().includes('../node_modules/x'), false);
    assert.deepEqual(recomputed.ok ? [] : recomputed.error.map((reason) => reason.code), ['DEPENDENCY_NOT_LOCKED']);
  });

  it('never reads a bundled path outside the project and reports it', async () => {
    const sources = committedProject();
    const escaping = [
      {
        ...SAMPLE_BUNDLES[0],
        entry_point: PROBE_HANDLER,
        local_sources: [PROBE_HANDLER, '../escape.ts'],
        packages: [],
      },
      SAMPLE_BUNDLES[1],
    ];
    const recomputed = await recomputeScopeSnapshot(ENVIRONMENT, {
      sources,
      bundles: new FixedBundleInputResolver(escaping.filter((bundle) => bundle !== undefined)),
      installed: installedProject(),
      validator,
    });
    assert.equal(sources.reads().includes('../escape.ts'), false);
    assert.deepEqual(recomputed.ok ? [] : recomputed.error.map((reason) => reason.code), [
      'BUNDLE_INPUT_OUTSIDE_PROJECT',
    ]);
  });

  it('reports a scoped file that is not committed', async () => {
    const sources = committedProject();
    sources.remove(CLIENT_SOURCE);
    const recomputed = await recomputeScopeSnapshot(ENVIRONMENT, {
      sources,
      bundles: new FixedBundleInputResolver(SAMPLE_BUNDLES),
      installed: installedProject(),
      validator,
    });
    assert.deepEqual(recomputed, {
      ok: false,
      error: [
        {
          code: 'SCOPED_SOURCE_NOT_COMMITTED',
          subject: 'BR-RUA-028',
          detail: `scoped source ${CLIENT_SOURCE} has no committed content; expected a committed file`,
        },
      ],
    });
  });

  it('refuses when the policy is not committed or invalid', async () => {
    const missing = committedProject();
    missing.remove(TRANSPORT_SCOPE_POLICY_PATH);
    assert.deepEqual(
      await recomputeScopeSnapshot(ENVIRONMENT, {
        sources: missing,
        bundles: new FixedBundleInputResolver(),
        installed: installedProject(),
        validator,
      }),
      {
        ok: false,
        error: [
          {
            code: 'SCOPE_POLICY_UNREADABLE',
            subject: 'BR-RUA-028',
            detail: `${TRANSPORT_SCOPE_POLICY_PATH} is not committed at the admitted revision; expected a committed file`,
          },
        ],
      },
    );
    const invalid = committedProject();
    invalid.commit(TRANSPORT_SCOPE_POLICY_PATH, '{"schema_version":1}');
    const bundles = new FixedBundleInputResolver(SAMPLE_BUNDLES);
    const result = await recomputeScopeSnapshot(ENVIRONMENT, {
      sources: invalid,
      bundles,
      installed: installedProject(),
      validator,
    });
    assert.ok(!result.ok);
    assert.deepEqual(new Set(result.error.map((reason) => reason.code)), new Set(['SCOPE_POLICY_INVALID']));
    assert.deepEqual(bundles.requests(), []);
  });

  it('refuses when the lockfile is not committed or invalid', async () => {
    const missing = committedProject();
    missing.remove(PACKAGE_LOCK_PATH);
    assert.deepEqual(
      await recomputeScopeSnapshot(ENVIRONMENT, {
        sources: missing,
        bundles: new FixedBundleInputResolver(),
        installed: installedProject(),
        validator,
      }),
      {
        ok: false,
        error: [
          {
            code: 'LOCKFILE_UNREADABLE',
            subject: 'BR-RUA-028',
            detail: `${PACKAGE_LOCK_PATH} is not committed at the admitted revision; expected a committed file`,
          },
        ],
      },
    );
    const invalid = committedProject();
    invalid.commit(PACKAGE_LOCK_PATH, '{"lockfileVersion":1,"packages":{}}');
    assert.deepEqual(
      await recomputeScopeSnapshot(ENVIRONMENT, {
        sources: invalid,
        bundles: new FixedBundleInputResolver(),
        installed: installedProject(),
        validator,
      }),
      {
        ok: false,
        error: [
          {
            code: 'LOCKFILE_INVALID',
            subject: 'BR-RUA-028',
            detail: 'package-lock.json has lockfileVersion number 1; expected 2 or 3',
          },
        ],
      },
    );
  });

  it('turns a bundler rejection into a structured reason', async () => {
    const bundles = new FixedBundleInputResolver(SAMPLE_BUNDLES);
    bundles.failWith('Could not resolve "../provider-client/missing.ts"');
    assert.deepEqual(
      await recomputeScopeSnapshot(ENVIRONMENT, {
        sources: committedProject(),
        bundles,
        installed: installedProject(),
        validator,
      }),
      {
        ok: false,
        error: [
          {
            code: 'BUNDLE_RESOLUTION_FAILED',
            subject: 'BR-RUA-028',
            detail:
              `bundling ${JSON.stringify(SAMPLE_POLICY.entry_points)} failed: Could not resolve "../provider-client/missing.ts"; ` +
              'expected every entry point and import to resolve',
          },
        ],
      },
    );
  });

  it('reports a thrown non-Error value by its string form', async () => {
    const bundles = new FixedBundleInputResolver(SAMPLE_BUNDLES);
    bundles.failWithNonError('plain failure');
    const result = await recomputeScopeSnapshot(ENVIRONMENT, {
      sources: committedProject(),
      bundles,
      installed: installedProject(),
      validator,
    });
    assert.ok(!result.ok);
    assert.match(result.error[0]?.detail ?? '', /failed: plain failure; expected every entry point/);
  });

  it('binds the policy digest over the exact committed policy bytes', async () => {
    const sources = committedProject();
    const pretty = new TextEncoder().encode(`${JSON.stringify(SAMPLE_POLICY, null, 2)}\n`);
    sources.commit(TRANSPORT_SCOPE_POLICY_PATH, pretty);
    const recomputed = await recomputeScopeSnapshot(ENVIRONMENT, {
      sources,
      bundles: new FixedBundleInputResolver(SAMPLE_BUNDLES),
      installed: installedProject(),
      validator,
    });
    assert.ok(recomputed.ok);
    assert.equal(recomputed.value.policy_sha256, createHash('sha256').update(pretty).digest('hex'));
  });
});

describe('recomputeScopeSnapshot port failures (regression: verify/eng-git-reader.log)', () => {
  const READ_DETAIL = 'expected the admitted revision to be readable';

  async function recomputeWith(sources: MemoryCommittedSourceReader): ReturnType<typeof recomputeScopeSnapshot> {
    return recomputeScopeSnapshot(ENVIRONMENT, {
      sources,
      bundles: new FixedBundleInputResolver(SAMPLE_BUNDLES),
      installed: installedProject(),
      validator,
    });
  }

  it('reports an unreadable policy read as a source read failure, not as an uncommitted policy', async () => {
    const sources = committedProject();
    sources.failWith('read', 'git ls-tree no-such-revision exited 128: fatal: Not a valid object name');
    assert.deepEqual(await recomputeWith(sources), {
      ok: false,
      error: [
        {
          code: 'SOURCE_READ_FAILED',
          subject: 'BR-RUA-028',
          detail:
            `reading committed ${TRANSPORT_SCOPE_POLICY_PATH} failed: git ls-tree no-such-revision exited 128: ` +
            `fatal: Not a valid object name; ${READ_DETAIL}`,
        },
      ],
    });
  });

  it('reports an unreadable lockfile read as a source read failure', async () => {
    const sources = committedProject();
    sources.failWith('read', 'object corrupt', PACKAGE_LOCK_PATH);
    assert.deepEqual(await recomputeWith(sources), {
      ok: false,
      error: [
        {
          code: 'SOURCE_READ_FAILED',
          subject: 'BR-RUA-028',
          detail: `reading committed ${PACKAGE_LOCK_PATH} failed: object corrupt; ${READ_DETAIL}`,
        },
      ],
    });
  });

  it('reports an unreadable scoped file as a source read failure, not as uncommitted', async () => {
    const sources = committedProject();
    sources.failWith('read', 'maxBuffer exceeded', CLIENT_SOURCE);
    assert.deepEqual(await recomputeWith(sources), {
      ok: false,
      error: [
        {
          code: 'SOURCE_READ_FAILED',
          subject: 'BR-RUA-028',
          detail: `reading committed ${CLIENT_SOURCE} failed: maxBuffer exceeded; ${READ_DETAIL}`,
        },
      ],
    });
  });

  it('reports an unreadable installed manifest as its own reason, not as a missing package', async () => {
    const installed = installedProject();
    installed.failWith(
      'node_modules/transport-dep/package.json is not one JSON document (invalid_json)',
      'node_modules/transport-dep',
    );
    assert.deepEqual(
      await recomputeScopeSnapshot(ENVIRONMENT, {
        sources: committedProject(),
        bundles: new FixedBundleInputResolver(SAMPLE_BUNDLES),
        installed,
        validator,
      }),
      {
        ok: false,
        error: [
          {
            code: 'INSTALLED_PACKAGE_UNREADABLE',
            subject: 'BR-RUA-028',
            detail:
              'reading the installed node_modules/transport-dep/package.json failed: node_modules/transport-dep/package.json ' +
              'is not one JSON document (invalid_json); expected the installed package manifest to be readable',
          },
        ],
      },
    );
  });

  it('resolves a listing failure to a reason instead of rejecting', async () => {
    const sources = committedProject();
    sources.failWith('listFiles', 'git ls-tree HEAD exited 128: fatal: not a git repository');
    assert.deepEqual(await recomputeWith(sources), {
      ok: false,
      error: [
        {
          code: 'SOURCE_READ_FAILED',
          subject: 'BR-RUA-028',
          detail:
            `listing the committed files under ${JSON.stringify(SAMPLE_POLICY.source_roots)} failed: ` +
            `git ls-tree HEAD exited 128: fatal: not a git repository; ${READ_DETAIL}`,
        },
      ],
    });
  });
});

describe('recomputeScopeSnapshot runtime properties', () => {
  it('binds the runtime properties the bundler resolved with', async () => {
    const bundles = new FixedBundleInputResolver(SAMPLE_BUNDLES, { bundle_format: 'cjs', bundle_target: 'node22' });
    const recomputed = await recomputeScopeSnapshot(
      { ...ENVIRONMENT, runtime: { unrelated_property: 'ignored' } },
      { sources: committedProject(), bundles, installed: installedProject(), validator },
    );
    assert.ok(recomputed.ok);
    assert.deepEqual(recomputed.value.runtime_properties, { bundle_format: 'cjs', bundle_target: 'node22' });
  });

  it('refuses an environment value that contradicts the bundler, before bundling', async () => {
    const bundles = new FixedBundleInputResolver(SAMPLE_BUNDLES, { bundle_format: 'cjs', bundle_target: 'node24' });
    assert.deepEqual(
      await recomputeScopeSnapshot(ENVIRONMENT, {
        sources: committedProject(),
        bundles,
        installed: installedProject(),
        validator,
      }),
      {
        ok: false,
        error: [
          {
            code: 'RUNTIME_PROPERTY_INVALID',
            subject: 'BR-RUA-028',
            detail:
              'runtime property bundle_format is "esm" in the admission environment but the bundler resolved with "cjs"; ' +
              "expected the bundler's value",
          },
        ],
      },
    );
    assert.deepEqual(bundles.requests(), []);
  });
});
