// Step A8 (BR-RUA-045): the coordination table is the configured one, ACTIVE, keyed pk/sk as
// strings, deletion-protected, without TTL, at the schema version this source writes, with a
// readable lease item (COORDINATION_CONFIGURATION); a held or recovery-required lease is a
// conflicting owner whatever its expiry says (SAFETY).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assessCoordination } from '../../../src/admission/coordination-check.ts';
import type { CoordinationReadings } from '../../../src/admission/coordination-check.ts';
import { acquiredLeaseItem } from '../../../src/coordination-lease/lease-item.ts';
import { leaseOwnerOf } from '../../../src/coordination-lease/lease-store-port.ts';
import { err, ok } from '../../../src/record-contract/primitives.ts';
import type { Sha256Hex, UtcMillis, Uuid4 } from '../../../src/record-contract/primitives.ts';
import type { EnvironmentInput } from '../../../src/record-contract/records/group-a/environment_input.ts';
import { CONFIGURED_TABLE, environmentInput } from '../../support/admission/admission-fixtures.ts';

const ENVIRONMENT = environmentInput() as unknown as EnvironmentInput;
const OWNER = leaseOwnerOf(
  { execution_kind: 'RUN', run_id: '7d2c4b1a-9e8f-4a3b-8c2d-1e0f9a8b7c6d' as Uuid4 },
  'ab'.repeat(32) as Sha256Hex,
);
const HELD = acquiredLeaseItem(OWNER, '2026-01-01T00:00:00.000Z' as UtcMillis);
const READINGS: CoordinationReadings = { table: ok(CONFIGURED_TABLE), lease: ok(undefined) };

function verdictCodes(readings: Partial<CoordinationReadings>, environment = ENVIRONMENT): readonly string[] {
  const verdict = assessCoordination({ ...READINGS, ...readings }, environment);
  return verdict.passed ? [] : [verdict.rejection_class, ...verdict.reasons.map((reason) => reason.code)];
}

describe('assessCoordination (A8)', () => {
  it('admits the configured table with no lease item, or a released one', () => {
    const verdict = assessCoordination(READINGS, ENVIRONMENT);
    assert.ok(verdict.passed);
    assert.deepEqual(verdict.statement.observed, { lease: 'absent' });
    assert.deepEqual(verdictCodes({ lease: ok({ ...HELD, lease_status: 'RELEASED' }) }), []);
  });

  it('refuses each table misconfiguration with its own detail', () => {
    const verdict = assessCoordination(
      {
        ...READINGS,
        table: ok({
          table_arn: 'arn:aws:dynamodb:us-east-1:012345678901:table/other',
          table_status: 'CREATING',
          key_schema: [{ attribute_name: 'pk', key_type: 'HASH' }],
          deletion_protection_enabled: false,
          time_to_live_status: 'ENABLED',
        }),
      },
      ENVIRONMENT,
    );
    assert.ok(!verdict.passed);
    assert.equal(verdict.rejection_class, 'COORDINATION_CONFIGURATION');
    assert.deepEqual(
      verdict.reasons.map((reason) => reason.detail),
      [
        `table ARN is arn:aws:dynamodb:us-east-1:012345678901:table/other; expected ${ENVIRONMENT.coordination_table_arn}`,
        'table status is CREATING; expected ACTIVE',
        'key schema is [pk HASH undefined]; expected [pk HASH S, sk RANGE S]',
        'deletion protection is disabled; expected enabled',
        'TimeToLiveStatus is ENABLED; expected DISABLED, since TTL deletion never establishes release',
      ],
    );
  });

  it('refuses a schema version mismatch, an unreadable table and an unreadable lease', () => {
    const failure = { code: 'ResourceNotFoundException', detail: 'missing' };
    assert.deepEqual(
      verdictCodes(
        { table: err(failure), lease: err({ code: 'LEASE_ITEM_INVALID', detail: 'bad item' }) },
        { ...ENVIRONMENT, expected_coordination_schema_version: 2 },
      ),
      [
        'COORDINATION_CONFIGURATION',
        'COORDINATION_SCHEMA_VERSION_MISMATCH',
        'COORDINATION_TABLE_UNREADABLE',
        'LEASE_UNREADABLE',
      ],
    );
    const verdict = assessCoordination({ ...READINGS, lease: err({ code: 'X', detail: 'y' }) }, ENVIRONMENT);
    assert.deepEqual(verdict.statement.observed, { lease: 'unreadable' });
    assert.deepEqual(verdictCodes({ lease: err({ code: 'X', detail: 'y' }) }), [
      'COORDINATION_CONFIGURATION',
      'LEASE_UNREADABLE',
    ]);
  });

  it('refuses a held or recovery-required lease as SAFETY, even when expired', () => {
    assert.deepEqual(verdictCodes({ lease: ok(HELD) }), ['SAFETY', 'CONFLICTING_LEASE']);
    assert.deepEqual(verdictCodes({ lease: ok({ ...HELD, lease_status: 'RECOVERY_REQUIRED' }) }), [
      'SAFETY',
      'CONFLICTING_LEASE',
    ]);
    const verdict = assessCoordination({ ...READINGS, lease: ok(HELD) }, ENVIRONMENT);
    assert.ok(!verdict.passed);
    assert.match(
      verdict.reasons[0].detail,
      /^the lease is RUN 7d2c4b1a-9e8f-4a3b-8c2d-1e0f9a8b7c6d .* HELD at version 1, expires_at 2026-01-01T00:05:00.000Z; expected no item or a RELEASED one$/,
    );
    assert.deepEqual(verdict.statement.observed, { lease: 'HELD' });
  });
});
