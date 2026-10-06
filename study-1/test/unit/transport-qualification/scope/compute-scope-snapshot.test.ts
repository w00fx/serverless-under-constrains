// BR-RUA-028: the frozen snapshot holds the policy digest, resolved entry points, the
// transitive closure plus conservative-root sources with exact digests, the locked dependency
// closure, the normalized configuration, runtime properties, timing and the warm-up policy
// (addendum §2), and nothing that identifies one execution.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalJson, serializeRecordFile } from '../../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import type { JsonValue, Sha256Hex, StructuredReason } from '../../../../src/record-contract/primitives.ts';
import type { TransportScopeSnapshot } from '../../../../src/record-contract/records/group-a/transport_scope_snapshot.ts';
import { createRecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import type { BundleInputs } from '../../../../src/transport-qualification/scope/bundle-inputs.ts';
import {
  computeScopeSnapshot,
  isUnderSourceRoot,
  scopeSnapshotSha256,
} from '../../../../src/transport-qualification/scope/scope-snapshot.ts';
import type { ScopeSnapshotInput } from '../../../../src/transport-qualification/scope/scope-snapshot.ts';
import {
  CLIENT_SOURCE,
  CLIENT_TIMING_FILE,
  ORACLE_SOURCE,
  PROBE_HANDLER,
  PROVIDER_HANDLER,
  SAMPLE_BUNDLES,
  SAMPLE_COMMITTED_FILES,
  SAMPLE_LOCK_ENTRIES,
  SAMPLE_POLICY,
  SAMPLE_TIMING,
  SHARED_PRIMITIVES,
  cdkTemplate,
  digestsOf,
  loadedPolicy,
  sampleSnapshotInput,
} from './support/scope-fixtures.ts';

const encoder = new TextEncoder();

function snapshotOf(input: ScopeSnapshotInput): TransportScopeSnapshot {
  const result = computeScopeSnapshot(input);
  assert.ok(result.ok, `expected a snapshot, got ${JSON.stringify(result)}`);
  return result.value;
}

function reasonsOf(input: ScopeSnapshotInput): readonly StructuredReason[] {
  const result = computeScopeSnapshot(input);
  assert.ok(!result.ok, 'expected the snapshot to be refused');
  return result.error;
}

function digest(text: string): Sha256Hex {
  return sha256Hex(encoder.encode(text));
}

/** The snapshot as the plain JSON value it serializes to, for the canonical writer. */
function plainJson(snapshot: TransportScopeSnapshot): JsonValue {
  return JSON.parse(JSON.stringify(snapshot)) as JsonValue;
}

function fileDigest(path: string): Sha256Hex {
  return digest(SAMPLE_COMMITTED_FILES[path] ?? '');
}

const KEY_SCHEMA = [
  { AttributeName: 'pk', KeyType: 'HASH' },
  { AttributeName: 'sk', KeyType: 'RANGE' },
];

// A sample function without reserved concurrency: the unset property keeps only its path.
const UNRESERVED_FUNCTION = {
  property_values: [
    { property_path: 'Properties.MemorySize', canonical_json: '512' },
    { property_path: 'Properties.ReservedConcurrentExecutions' },
    { property_path: 'Properties.Timeout', canonical_json: '30' },
  ],
} as const;

describe('computeScopeSnapshot', () => {
  it('binds every BR-RUA-028 snapshot element in canonical order', () => {
    const snapshot = snapshotOf(sampleSnapshotInput());
    const scopedLock = Object.fromEntries(
      [
        'node_modules/@scope/declared-dep',
        'node_modules/transport-dep',
        'node_modules/transport-dep/node_modules/@inner/helper',
      ].map((path) => {
        const entry = SAMPLE_LOCK_ENTRIES[path];
        return [
          path,
          { version: entry?.version ?? '', resolved: entry?.resolved ?? '', integrity: entry?.integrity ?? '' },
        ];
      }),
    );
    assert.deepEqual(snapshot, {
      schema_version: 1,
      record_type: 'transport_scope_snapshot',
      policy_sha256: sha256Hex(serializeRecordFile(SAMPLE_POLICY)),
      entry_points: [PROVIDER_HANDLER, PROBE_HANDLER],
      source_files: [
        { path: CLIENT_SOURCE, sha256: fileDigest(CLIENT_SOURCE) },
        { path: CLIENT_TIMING_FILE, sha256: fileDigest(CLIENT_TIMING_FILE) },
        { path: SHARED_PRIMITIVES, sha256: fileDigest(SHARED_PRIMITIVES) },
        { path: PROVIDER_HANDLER, sha256: fileDigest(PROVIDER_HANDLER) },
        { path: PROBE_HANDLER, sha256: fileDigest(PROBE_HANDLER) },
      ],
      dependency_closure: [
        { name: '@inner/helper', version: '2.0.0' },
        { name: '@scope/declared-dep', version: '4.1.0' },
        { name: 'transport-dep', version: '1.0.0' },
      ],
      lockfile_sha256: digest(canonicalJson(scopedLock)),
      configuration_projections: [
        {
          projection_id: 'experiment_core__functions',
          resources: [UNRESERVED_FUNCTION, UNRESERVED_FUNCTION],
        },
        {
          projection_id: 'experiment_core__tables',
          // canonical order: the table that sets its stream sorts before the one that does not
          resources: [
            {
              property_values: [
                { property_path: 'Properties.KeySchema', canonical_json: canonicalJson(KEY_SCHEMA) },
                { property_path: 'Properties.StreamSpecification', canonical_json: '{"StreamViewType":"NEW_IMAGE"}' },
              ],
            },
            {
              property_values: [
                { property_path: 'Properties.KeySchema', canonical_json: canonicalJson(KEY_SCHEMA) },
                { property_path: 'Properties.StreamSpecification' },
              ],
            },
          ],
        },
      ],
      runtime_properties: { bundle_format: 'esm', bundle_target: 'node24' },
      timing_values: SAMPLE_TIMING,
      provider_warmup: { invocations_per_trial: 1 },
    });
  });

  it('produces a record the transport_scope_snapshot schema accepts', () => {
    const validation = createRecordValidator().validateAs(
      'transport_scope_snapshot',
      plainJson(snapshotOf(sampleSnapshotInput())),
    );
    assert.deepEqual(validation.valid ? [] : validation.violations, []);
  });

  it('is byte-identical for a probe stack and a run stack with the same transport configuration', () => {
    const probe = snapshotOf(sampleSnapshotInput({ template: cdkTemplate({ kind: 'probe', hash: 'AAAA1111' }) }));
    const run = snapshotOf(
      sampleSnapshotInput({
        template: cdkTemplate({
          kind: 'run',
          executionId: '9d8c7b6a-1234-4abc-8def-0123456789ab',
          hash: 'BBBB2222',
          variantTimeout: 20,
        }),
      }),
    );
    assert.equal(scopeSnapshotSha256(run), scopeSnapshotSha256(probe));
  });

  it('changes when a scoped configuration value changes', () => {
    const base = snapshotOf(sampleSnapshotInput());
    const changed = snapshotOf(sampleSnapshotInput({ template: cdkTemplate({ providerReservedConcurrency: 1 }) }));
    assert.notEqual(scopeSnapshotSha256(changed), scopeSnapshotSha256(base));
    assert.deepEqual(changed.configuration_projections[0].resources, [
      {
        property_values: [
          { property_path: 'Properties.MemorySize', canonical_json: '512' },
          { property_path: 'Properties.ReservedConcurrentExecutions', canonical_json: '1' },
          { property_path: 'Properties.Timeout', canonical_json: '30' },
        ],
      },
      UNRESERVED_FUNCTION,
    ]);
  });

  it('leaves out committed files outside the source roots and the bundle closure', () => {
    const changedOracle = { ...SAMPLE_COMMITTED_FILES, [ORACLE_SOURCE]: "export const oracle = 'v2';\n" };
    const base = snapshotOf(sampleSnapshotInput({ committed_files: [...Object.keys(SAMPLE_COMMITTED_FILES)] }));
    const changed = snapshotOf(
      sampleSnapshotInput({
        committed_files: [...Object.keys(changedOracle)],
        source_digests: digestsOf(changedOracle),
      }),
    );
    assert.equal(scopeSnapshotSha256(changed), scopeSnapshotSha256(base));
    assert.equal(
      base.source_files.some((file) => file.path === ORACLE_SOURCE),
      false,
    );
  });

  it('copies the timing values and warm-up policy exactly, without extra fields', () => {
    const timing = { ...SAMPLE_TIMING, extra_ms: 5 };
    const warmup = { invocations_per_trial: 1 as const, extra: true };
    const snapshot = snapshotOf(sampleSnapshotInput({ timing, provider_warmup: warmup }));
    assert.deepEqual(snapshot.timing_values, SAMPLE_TIMING);
    assert.deepEqual(snapshot.provider_warmup, { invocations_per_trial: 1 });
  });
});

describe('computeScopeSnapshot refusals', () => {
  it('requires exactly one bundle per entry point', () => {
    const missing = reasonsOf(sampleSnapshotInput({ bundles: SAMPLE_BUNDLES.slice(0, 1) }));
    assert.deepEqual(missing, [
      {
        code: 'BUNDLE_MISSING_ENTRY_POINT',
        subject: 'BR-RUA-028',
        detail: `entry point ${PROVIDER_HANDLER} has 0 resolved bundles; expected exactly one`,
      },
    ]);
    const duplicated = reasonsOf(sampleSnapshotInput({ bundles: [...SAMPLE_BUNDLES, ...SAMPLE_BUNDLES.slice(1)] }));
    assert.deepEqual(
      duplicated.map((reason) => reason.detail),
      [`entry point ${PROVIDER_HANDLER} has 2 resolved bundles; expected exactly one`],
    );
  });

  it('refuses a bundled input outside the project', () => {
    const [probeBundle] = SAMPLE_BUNDLES;
    assert.ok(probeBundle !== undefined);
    const bundles: readonly BundleInputs[] = [
      probeBundle,
      { entry_point: PROVIDER_HANDLER, local_sources: ['../escape.ts', PROVIDER_HANDLER], packages: [] },
    ];
    assert.deepEqual(reasonsOf(sampleSnapshotInput({ bundles })), [
      {
        code: 'BUNDLE_INPUT_OUTSIDE_PROJECT',
        subject: 'BR-RUA-028',
        detail: 'bundled input "../escape.ts"; expected a normalized path inside the project',
      },
    ]);
  });

  it('refuses a source root that holds no committed file', () => {
    const policy = { ...SAMPLE_POLICY, source_roots: ['src/provider-client', 'src/missing-root'] as const };
    assert.deepEqual(reasonsOf(sampleSnapshotInput({ policy: loadedPolicy(policy) })), [
      {
        code: 'SOURCE_ROOT_EMPTY',
        subject: 'BR-RUA-028',
        detail: 'source root src/missing-root holds no committed file; expected at least one',
      },
    ]);
  });

  it('refuses a scoped source without committed content', () => {
    const digests = new Map(digestsOf(SAMPLE_COMMITTED_FILES));
    digests.delete(SHARED_PRIMITIVES);
    assert.deepEqual(reasonsOf(sampleSnapshotInput({ source_digests: digests })), [
      {
        code: 'SCOPED_SOURCE_NOT_COMMITTED',
        subject: 'BR-RUA-028',
        detail: `scoped source ${SHARED_PRIMITIVES} has no committed content; expected a committed file`,
      },
    ]);
  });

  it('refuses unlocked and development-only bundled packages', () => {
    const bundles = [
      {
        ...SAMPLE_BUNDLES[0],
        entry_point: PROBE_HANDLER,
        local_sources: [PROBE_HANDLER],
        packages: ['node_modules/dev-only', 'node_modules/ghost'],
      },
      SAMPLE_BUNDLES[1],
    ].filter((bundle) => bundle !== undefined);
    assert.deepEqual(
      reasonsOf(sampleSnapshotInput({ bundles })).map((reason) => reason.code),
      ['BUNDLED_PACKAGE_NOT_PRODUCTION', 'DEPENDENCY_NOT_LOCKED'],
    );
  });

  it('reports a malformed template once, not once per projection', () => {
    assert.deepEqual(reasonsOf(sampleSnapshotInput({ template: { Resources: [] } })), [
      {
        code: 'TEMPLATE_INVALID',
        subject: 'BR-RUA-028',
        detail: 'template Resources is []; expected an object of resources',
      },
    ]);
  });

  it('refuses a projection that selects nothing', () => {
    const reasons = reasonsOf(sampleSnapshotInput({ template: { Resources: {} } }));
    assert.deepEqual(
      reasons.map((reason) => reason.code),
      ['PROJECTION_SELECTS_NOTHING', 'PROJECTION_SELECTS_NOTHING'],
    );
  });

  it('refuses a missing, inherited or non-integer runtime property', () => {
    const policy = loadedPolicy({
      ...SAMPLE_POLICY,
      runtime_properties: ['bundle_format', 'bundle_target', 'constructor'],
    });
    assert.deepEqual(
      reasonsOf(sampleSnapshotInput({ policy, runtime: { bundle_format: 'esm', bundle_target: 1.5 } })),
      [
        {
          code: 'RUNTIME_PROPERTY_INVALID',
          subject: 'BR-RUA-028',
          detail: 'runtime property bundle_target is 1.5; expected a safe integer',
        },
        {
          code: 'RUNTIME_PROPERTY_MISSING',
          subject: 'BR-RUA-028',
          detail: 'runtime property constructor is absent; expected a string, integer or boolean',
        },
      ],
    );
  });

  it('accepts integer and boolean runtime properties', () => {
    const snapshot = snapshotOf(sampleSnapshotInput({ runtime: { bundle_format: false, bundle_target: 24 } }));
    assert.deepEqual(snapshot.runtime_properties, { bundle_format: false, bundle_target: 24 });
  });

  it('refuses non-positive or fractional timing values', () => {
    const timing = { ...SAMPLE_TIMING, provider_client_deadline_ms: 0, treatment_poll_interval_ms: 2.5 };
    assert.deepEqual(reasonsOf(sampleSnapshotInput({ timing })), [
      {
        code: 'TIMING_VALUE_INVALID',
        subject: 'BR-RUA-028',
        detail: 'timing value provider_client_deadline_ms is 0; expected a positive safe integer of milliseconds',
      },
      {
        code: 'TIMING_VALUE_INVALID',
        subject: 'BR-RUA-028',
        detail: 'timing value treatment_poll_interval_ms is 2.5; expected a positive safe integer of milliseconds',
      },
    ]);
    assert.ok(
      computeScopeSnapshot(sampleSnapshotInput({ timing: { ...SAMPLE_TIMING, treatment_poll_interval_ms: 1 } })).ok,
    );
  });

  it('collects every violation in a stable order', () => {
    const reasons = reasonsOf(
      sampleSnapshotInput({
        bundles: SAMPLE_BUNDLES.slice(0, 1),
        source_digests: new Map(),
        template: { Resources: 'none' },
        runtime: {},
        timing: { ...SAMPLE_TIMING, provider_safety_release_ms: -1 },
      }),
    );
    assert.deepEqual(
      reasons.map((reason) => reason.code),
      [
        'BUNDLE_MISSING_ENTRY_POINT',
        // the probe closure (client, shared primitives, probe handler) plus the root-only
        // files (client timing, provider handler)
        'SCOPED_SOURCE_NOT_COMMITTED',
        'SCOPED_SOURCE_NOT_COMMITTED',
        'SCOPED_SOURCE_NOT_COMMITTED',
        'SCOPED_SOURCE_NOT_COMMITTED',
        'SCOPED_SOURCE_NOT_COMMITTED',
        'TEMPLATE_INVALID',
        'RUNTIME_PROPERTY_MISSING',
        'RUNTIME_PROPERTY_MISSING',
        'TIMING_VALUE_INVALID',
      ],
    );
  });
});

describe('scopeSnapshotSha256', () => {
  it('digests the canonical record file bytes', () => {
    const snapshot = snapshotOf(sampleSnapshotInput());
    assert.equal(scopeSnapshotSha256(snapshot), digest(`${canonicalJson(plainJson(snapshot))}\n`));
  });
});

describe('isUnderSourceRoot', () => {
  it('accepts the root itself and paths below it, nothing else', () => {
    assert.equal(isUnderSourceRoot('src/provider-client', 'src/provider-client'), true);
    assert.equal(isUnderSourceRoot('src/provider-client/a/b.ts', 'src/provider-client'), true);
    assert.equal(isUnderSourceRoot('src/provider-client-extra/x.ts', 'src/provider-client'), false);
    assert.equal(isUnderSourceRoot('src/provider', 'src/provider-client'), false);
    assert.equal(isUnderSourceRoot('lib/src/provider-client/x.ts', 'src/provider-client'), false);
  });
});
