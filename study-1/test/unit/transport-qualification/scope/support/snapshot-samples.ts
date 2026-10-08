// The sample scope snapshot shared by the compareScopeSnapshots unit cases and its property
// (test/fuzz/transport-qualification/scope/compare-scope-snapshots.fuzz.test.ts, Owner amendment A-11).

import assert from 'node:assert/strict';

import type { TransportScopeSnapshot } from '../../../../../src/record-contract/records/group-a/transport_scope_snapshot.ts';
import { computeScopeSnapshot } from '../../../../../src/transport-qualification/scope/scope-snapshot.ts';
import { sampleSnapshotInput } from './scope-fixtures.ts';

/**
 * The snapshot computed from the sample input; fails the test when it cannot be computed.
 *
 * @example
 * baseSnapshot().policy_sha256; // the sample policy digest
 */
export function baseSnapshot(): TransportScopeSnapshot {
  const result = computeScopeSnapshot(sampleSnapshotInput());
  assert.ok(result.ok);
  return result.value;
}
