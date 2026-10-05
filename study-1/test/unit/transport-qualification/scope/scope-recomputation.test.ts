// Recomputing the scope from committed source (BR-RUA-028): the policy and lockfile come from
// the committed tree, every scoped file is digested from committed bytes, and every failure is
// a structured qualification reason. Runs over the named fakes of both read ports.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import { PACKAGE_LOCK_PATH } from '../../../../src/transport-qualification/scope/package-lock.ts';
import { recomputeScopeSnapshot } from '../../../../src/transport-qualification/scope/scope-recomputation.ts';
import type { ScopeEnvironment } from '../../../../src/transport-qualification/scope/scope-recomputation.ts';
import { TRANSPORT_SCOPE_POLICY_PATH } from '../../../../src/transport-qualification/scope/scope-policy.ts';
import { computeScopeSnapshot } from '../../../../src/transport-qualification/scope/scope-snapshot.ts';
import { FixedBundleInputResolver } from './support/fixed-bundle-input-resolver.ts';
import { MemoryCommittedSourceReader } from './support/memory-committed-source-reader.ts';
import {
  CLIENT_SOURCE,
  ORACLE_SOURCE,
  PROBE_HANDLER,
  SAMPLE_BUNDLES,
  SAMPLE_COMMITTED_FILES,
  SAMPLE_LOCK_BYTES,
  SAMPLE_POLICY,
  SAMPLE_RUNTIME,
  SAMPLE_TIMING,
  cdkTemplate,
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
    [TRANSPORT_SCOPE_POLICY_PATH]: JSON.stringify(SAMPLE_POLICY),
    [PACKAGE_LOCK_PATH]: SAMPLE_LOCK_BYTES,
  });
}

describe('recomputeScopeSnapshot', () => {
  it('computes the same snapshot as the pure computation over the committed inputs', async () => {
    const sources = committedProject();
    const bundles = new FixedBundleInputResolver(SAMPLE_BUNDLES);
    const recomputed = await recomputeScopeSnapshot(ENVIRONMENT, { sources, bundles, validator });
    assert.deepEqual(recomputed, computeScopeSnapshot(sampleSnapshotInput()));
    assert.deepEqual(bundles.requests(), [SAMPLE_POLICY.entry_points]);
  });

  it('reads the policy, the lockfile and each scoped file once, never an unrelated file', async () => {
    const sources = committedProject();
    await recomputeScopeSnapshot(ENVIRONMENT, {
      sources,
      bundles: new FixedBundleInputResolver(SAMPLE_BUNDLES),
      validator,
    });
    const reads = sources.reads();
    assert.deepEqual(reads.slice(0, 2), [TRANSPORT_SCOPE_POLICY_PATH, PACKAGE_LOCK_PATH]);
    assert.equal(new Set(reads).size, reads.length);
    assert.equal(reads.includes(ORACLE_SOURCE), false);
    assert.equal(reads.includes(CLIENT_SOURCE), true);
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
    const result = await recomputeScopeSnapshot(ENVIRONMENT, { sources: invalid, bundles, validator });
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
    assert.deepEqual(await recomputeScopeSnapshot(ENVIRONMENT, { sources: committedProject(), bundles, validator }), {
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
    });
  });

  it('reports a thrown non-Error value by its string form', async () => {
    const bundles = new FixedBundleInputResolver(SAMPLE_BUNDLES);
    bundles.failWithNonError('plain failure');
    const result = await recomputeScopeSnapshot(ENVIRONMENT, { sources: committedProject(), bundles, validator });
    assert.ok(!result.ok);
    assert.match(result.error[0]?.detail ?? '', /failed: plain failure; expected every entry point/);
  });
});
