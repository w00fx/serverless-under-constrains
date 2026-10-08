// BR-RUA-028 / AC-RUA-051: compareScopeSnapshots reports drift exactly when the canonical
// snapshots differ (testing rule 6). The example cases are in test/unit/transport-qualification/scope/compare-scope-snapshots.test.ts; the property lives here so
// `npm run test:fuzz` and `fuzz:campaign` reach it (Owner amendment A-11).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { canonicalJson } from '../../../../src/record-contract/canonical-json.ts';
import type { JsonValue, Sha256Hex } from '../../../../src/record-contract/primitives.ts';
import type { TransportScopeSnapshot } from '../../../../src/record-contract/records/group-a/transport_scope_snapshot.ts';
import { compareScopeSnapshots } from '../../../../src/transport-qualification/scope/scope-drift.ts';
import { fuzzParameters } from '../../../support/kernel/fuzz-parameters.ts';
import { baseSnapshot } from '../../../unit/transport-qualification/scope/support/snapshot-samples.ts';

/** The snapshot as the plain JSON value it serializes to, for the canonical writer. */
function plainJson(snapshot: TransportScopeSnapshot): JsonValue {
  return JSON.parse(JSON.stringify(snapshot)) as JsonValue;
}

const base = baseSnapshot();

describe('compareScopeSnapshots: property', () => {
  it('reports drift exactly when the canonical snapshots differ, with one reason per item', () => {
    const sha = fc.stringMatching(/^[0-9a-f]{64}$/).map((value) => value as Sha256Hex);
    const candidate: fc.Arbitrary<TransportScopeSnapshot> = fc.oneof(
      sha.map((value) => ({ ...base, policy_sha256: value })),
      sha.map((value) => ({ ...base, lockfile_sha256: value })),
      fc.integer({ min: 1, max: 5000 }).map((value) => ({
        ...base,
        timing_values: { ...base.timing_values, provider_client_deadline_ms: value },
      })),
      fc
        .subarray([...base.source_files], { minLength: 1 })
        .map((files) => ({ ...base, source_files: files as unknown as TransportScopeSnapshot['source_files'] })),
      fc.subarray([...base.dependency_closure], { minLength: 1 }).map((closure) => ({
        ...base,
        dependency_closure: closure as unknown as TransportScopeSnapshot['dependency_closure'],
      })),
      fc
        .dictionary(
          fc.constantFrom('bundle_format', 'bundle_target', 'other'),
          fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        )
        .map((runtime) => ({ ...base, runtime_properties: runtime })),
    );
    fc.assert(
      fc.property(candidate, (recomputed) => {
        const assessment = compareScopeSnapshots(base, recomputed);
        assert.equal(
          assessment.status === 'no_drift',
          canonicalJson(plainJson(base)) === canonicalJson(plainJson(recomputed)),
        );
        if (assessment.status === 'drift') {
          assert.ok(assessment.items.length > 0);
          assert.deepEqual(
            assessment.reasons.map((reason) => reason.code),
            assessment.items.map((item) => item.code),
          );
        }
      }),
      fuzzParameters(),
    );
  });
});
