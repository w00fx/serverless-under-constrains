// fast-check arbitraries of the coordination lease (testing rule 6): valid lease items, hostile
// replacements for one member (any JSON, non-finite numbers, near-miss strings, deep nesting),
// and an independent reference model of item validity written from the layout in design §9.1,
// not from the decoder.

import fc from 'fast-check';

import type { LeaseItem, LeaseOwner } from '../../../src/coordination-lease/lease-item.ts';
import type { JsonValue, Sha256Hex, Uuid4, UtcMillis } from '../../../src/record-contract/primitives.ts';

const MIN_INSTANT = Date.UTC(2000, 0, 1);
const MAX_INSTANT = Date.UTC(2099, 11, 31, 23, 59, 59, 999);

export const leaseUuid4: fc.Arbitrary<Uuid4> = fc.uuid({ version: 4 }).map((uuid) => uuid as Uuid4);

export const leaseSha256: fc.Arbitrary<Sha256Hex> = fc
  .array(
    fc.integer({ min: 0, max: 15 }).map((digit) => digit.toString(16)),
    { minLength: 64, maxLength: 64 },
  )
  .map((digits) => digits.join('') as Sha256Hex);

export const leaseInstant: fc.Arbitrary<UtcMillis> = fc
  .integer({ min: MIN_INSTANT, max: MAX_INSTANT })
  .map((ms) => new Date(ms).toISOString() as UtcMillis);

export const leaseOwner: fc.Arbitrary<LeaseOwner> = fc.record({
  owner_kind: fc.constantFrom('RUN', 'TRANSPORT_PROBE', 'VARIANT_VALIDATION'),
  owner_id: leaseUuid4,
  owner_manifest_sha256: leaseSha256,
});

/** Any valid lease item. */
export const validLeaseItem: fc.Arbitrary<LeaseItem> = fc
  .record({
    owner: leaseOwner,
    lease_status: fc.constantFrom('HELD', 'RELEASED', 'RECOVERY_REQUIRED'),
    lease_version: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    acquired_at: leaseInstant,
    heartbeat_at: leaseInstant,
    expires_at: leaseInstant,
    updated_at: leaseInstant,
  })
  .map(({ owner, ...rest }) => ({
    pk: 'lease#study-1',
    sk: 'current',
    coordination_schema_version: 1 as const,
    ...owner,
    ...rest,
  }));

/** The closed member names of the lease item, in layout order. */
export const LEASE_MEMBER_NAMES = [
  'pk',
  'sk',
  'coordination_schema_version',
  'lease_status',
  'owner_kind',
  'owner_id',
  'owner_manifest_sha256',
  'lease_version',
  'acquired_at',
  'heartbeat_at',
  'expires_at',
  'updated_at',
] as const;

function deepArray(depth: number): JsonValue {
  let value: JsonValue = [];
  for (let level = 0; level < depth; level += 1) {
    value = [value];
  }
  return value;
}

/** Hostile values for one member: any JSON, non-finite and edge numbers, near-miss strings, deep nesting. */
export const hostileMemberValue: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.jsonValue() as fc.Arbitrary<JsonValue>,
  fc.constantFrom<JsonValue>(
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NaN,
    0,
    -1,
    1,
    1.5,
    2 ** 53,
    Number.MAX_SAFE_INTEGER,
    'HELD',
    'held',
    'RELEASED ',
    'lease#study-1',
    'current',
    'RUN',
    '2026-10-05T12:00:00.000Z',
    '2026-10-05T12:00:00Z',
    '2026-02-30T00:00:00.000Z',
    '3f1c2a9e-8b4d-4c1e-9f00-1a2b3c4d5e6f',
    '3F1C2A9E-8B4D-4C1E-9F00-1A2B3C4D5E6F',
    'a1'.repeat(32),
    'A1'.repeat(32),
    null,
  ),
  leaseInstant,
  leaseUuid4,
  leaseSha256,
  fc.integer({ min: 1, max: 100_000 }).map(deepArray),
);

/** Member names that are not part of the layout, including inherited and prototype names. */
export const foreignMemberName: fc.Arbitrary<string> = fc
  .oneof(
    fc.string({ minLength: 1, maxLength: 20 }),
    fc.constantFrom('__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'ttl', 'PK'),
  )
  .filter((name) => !(LEASE_MEMBER_NAMES as readonly string[]).includes(name));

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isInstant(value: JsonValue): boolean {
  return typeof value === 'string' && INSTANT.test(value) && new Date(value).toISOString() === value;
}

const MODEL: Readonly<Record<(typeof LEASE_MEMBER_NAMES)[number], (value: JsonValue) => boolean>> = {
  pk: (value) => value === 'lease#study-1',
  sk: (value) => value === 'current',
  coordination_schema_version: (value) => value === 1,
  lease_status: (value) => value === 'HELD' || value === 'RELEASED' || value === 'RECOVERY_REQUIRED',
  owner_kind: (value) => value === 'RUN' || value === 'TRANSPORT_PROBE' || value === 'VARIANT_VALIDATION',
  owner_id: (value) => typeof value === 'string' && UUID4.test(value),
  owner_manifest_sha256: (value) => typeof value === 'string' && SHA256.test(value),
  lease_version: (value) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= Number.MAX_SAFE_INTEGER,
  acquired_at: isInstant,
  heartbeat_at: isInstant,
  expires_at: isInstant,
  updated_at: isInstant,
};

/**
 * The reference verdict on whether `value` is a valid value of `member`.
 *
 * @example
 * isValidLeaseMember('lease_version', Number.POSITIVE_INFINITY); // false
 */
export function isValidLeaseMember(member: (typeof LEASE_MEMBER_NAMES)[number], value: JsonValue): boolean {
  return MODEL[member](value);
}
