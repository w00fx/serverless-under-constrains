// The lease item layout and its total decoder (BR-RUA-045; design §9.1, §10.3; A-05, A-07):
// the closed item decodes only with every member valid and no other member; inherited names,
// non-finite numbers and 100k-deep values are refused with a bounded message that names the
// offending value and the expected shape; ownership compares kind, identity and manifest digest;
// only an explicitly released item (or none) is available, whatever its expiry says.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StoredItem } from '../../../src/durable-store/item-store-port.ts';
import {
  COORDINATION_SCHEMA_VERSION,
  LEASE_ITEM_KEY,
  LEASE_ITEM_STATUSES,
  LEASE_REASON_CODES,
  LEASE_RULE,
  LEASE_STALE_BOUNDARY_MS,
  acquiredLeaseItem,
  decodeLeaseItem,
  describeHolder,
  isLeaseAvailable,
  isOwnedBy,
  leaseExpiry,
  leaseReason,
  toStoredItem,
} from '../../../src/coordination-lease/lease-item.ts';
import { leaseOwnerOf } from '../../../src/coordination-lease/lease-store-port.ts';
import type { JsonValue, UtcMillis } from '../../../src/record-contract/primitives.ts';
import {
  EPOCH_UTC,
  FOREIGN_OWNER,
  OTHER_MANIFEST_SHA,
  RUN_EXECUTION,
  RUN_ID,
  RUN_MANIFEST_SHA,
  RUN_OWNER,
  leaseItem,
  storedLeaseItem,
} from '../../support/coordination-lease/lease-fixtures.ts';

const PAST = '2020-01-01T00:00:00.000Z' as UtcMillis;

function withMember(name: string, value: JsonValue): StoredItem {
  return { ...storedLeaseItem(RUN_OWNER, EPOCH_UTC), [name]: value };
}

function withoutMember(name: string): StoredItem {
  const kept = Object.entries(storedLeaseItem(RUN_OWNER, EPOCH_UTC)).filter(([member]) => member !== name);
  return Object.fromEntries(kept) as StoredItem;
}

function decodeDetail(item: StoredItem): string {
  const decoded = decodeLeaseItem(item);
  assert.equal(decoded.ok, false, 'expected the item to be refused');
  assert.equal(decoded.error.code, LEASE_REASON_CODES.itemUndecodable);
  assert.equal(decoded.error.subject, LEASE_RULE);
  return decoded.error.detail;
}

function deepArray(depth: number): JsonValue {
  let value: JsonValue = [];
  for (let level = 0; level < depth; level += 1) {
    value = [value];
  }
  return value;
}

describe('lease item constants', () => {
  it('pin the BR-RUA-045 layout: one item per study, three statuses, a 300 s boundary', () => {
    assert.deepEqual(LEASE_ITEM_KEY, { pk: 'lease#study-1', sk: 'current' });
    assert.deepEqual(LEASE_ITEM_STATUSES, ['HELD', 'RELEASED', 'RECOVERY_REQUIRED']);
    assert.equal(LEASE_STALE_BOUNDARY_MS, 300_000);
    assert.equal(COORDINATION_SCHEMA_VERSION, 1);
    assert.equal(LEASE_RULE, 'BR-RUA-045');
  });
});

describe('acquiredLeaseItem', () => {
  it('writes a held item at version 1 whose expiry is 300 s after the acquisition', () => {
    assert.deepEqual(acquiredLeaseItem(RUN_OWNER, EPOCH_UTC), {
      pk: 'lease#study-1',
      sk: 'current',
      coordination_schema_version: 1,
      lease_status: 'HELD',
      owner_kind: 'RUN',
      owner_id: RUN_ID,
      owner_manifest_sha256: RUN_MANIFEST_SHA,
      lease_version: 1,
      acquired_at: EPOCH_UTC,
      heartbeat_at: EPOCH_UTC,
      expires_at: '2026-10-05T12:05:00.000Z',
      updated_at: EPOCH_UTC,
    });
  });

  it('round-trips through the stored form and the decoder', () => {
    const item = acquiredLeaseItem(FOREIGN_OWNER, EPOCH_UTC);
    const stored = toStoredItem(item);
    assert.notEqual(stored, item);
    assert.deepEqual(decodeLeaseItem(stored), { ok: true, value: item });
  });
});

describe('leaseExpiry', () => {
  it('adds the stale boundary, across a day boundary too', () => {
    assert.equal(leaseExpiry('2026-10-05T23:58:00.500Z' as UtcMillis), '2026-10-06T00:03:00.500Z');
  });
});

describe('decodeLeaseItem', () => {
  it('accepts every status and owner kind', () => {
    for (const lease_status of LEASE_ITEM_STATUSES) {
      assert.equal(decodeLeaseItem(storedLeaseItem(RUN_OWNER, EPOCH_UTC, { lease_status })).ok, true);
    }
    assert.equal(decodeLeaseItem(storedLeaseItem(FOREIGN_OWNER, EPOCH_UTC, { lease_version: 2 ** 53 - 1 })).ok, true);
  });

  it('refuses an unknown member and lists the closed members', () => {
    const detail = decodeDetail(withMember('ttl', 1_700_000_000));
    assert.match(detail, /^lease item unknown member string "ttl"; expected only pk, sk, coordination_schema_version,/);
  });

  it('refuses inherited member names carried as own members (A-05)', () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const hostile = JSON.parse(
        JSON.stringify({ ...storedLeaseItem(RUN_OWNER, EPOCH_UTC) }).replace('{', `{"${name}":{"pk":"x"},`),
      ) as StoredItem;
      assert.match(decodeDetail(hostile), new RegExp(`unknown member string "${name}"`));
    }
  });

  it('never reads a member inherited from the prototype', () => {
    const inherited = Object.create(storedLeaseItem(RUN_OWNER, EPOCH_UTC)) as StoredItem;
    assert.equal(decodeDetail(inherited), 'lease item member pk is absent; expected "lease#study-1"');
  });

  it('names each missing member with its expected shape', () => {
    const expectations: Readonly<Record<string, string>> = {
      pk: '"lease#study-1"',
      sk: '"current"',
      coordination_schema_version: '1',
      lease_status: 'one of HELD, RELEASED, RECOVERY_REQUIRED',
      owner_kind: 'one of RUN, TRANSPORT_PROBE, VARIANT_VALIDATION',
      owner_id: 'a lowercase UUIDv4',
      owner_manifest_sha256: '64 lowercase hex digits',
      lease_version: 'a positive safe integer',
      acquired_at: 'a UTC instant YYYY-MM-DDTHH:mm:ss.SSSZ',
      heartbeat_at: 'a UTC instant YYYY-MM-DDTHH:mm:ss.SSSZ',
      expires_at: 'a UTC instant YYYY-MM-DDTHH:mm:ss.SSSZ',
      updated_at: 'a UTC instant YYYY-MM-DDTHH:mm:ss.SSSZ',
    };
    for (const [name, expected] of Object.entries(expectations)) {
      assert.equal(decodeDetail(withoutMember(name)), `lease item member ${name} is absent; expected ${expected}`);
    }
  });

  it('refuses each invalid value and quotes it', () => {
    const cases: readonly (readonly [string, JsonValue, string])[] = [
      ['pk', 'lease#study-2', 'string "lease#study-2"'],
      ['sk', 'previous', 'string "previous"'],
      ['coordination_schema_version', 2, 'number 2'],
      ['lease_status', 'held', 'string "held"'],
      ['owner_kind', 'CLEANUP', 'string "CLEANUP"'],
      ['owner_id', RUN_ID.toUpperCase(), `string "${RUN_ID.toUpperCase()}"`],
      ['owner_manifest_sha256', 'ab', 'string "ab"'],
      ['lease_version', 0, 'number 0'],
      ['lease_version', 1.5, 'number 1.5'],
      ['lease_version', '3', 'string "3"'],
      ['lease_version', 2 ** 53, `number ${String(2 ** 53)}`],
      ['acquired_at', '2026-10-05T12:00:00Z', 'string "2026-10-05T12:00:00Z"'],
      ['heartbeat_at', null, 'null null'],
      ['expires_at', 1_700_000_000_000, 'number 1700000000000'],
      ['updated_at', '2026-02-30T00:00:00.000Z', 'string "2026-02-30T00:00:00.000Z"'],
    ];
    for (const [name, value, shown] of cases) {
      assert.match(
        decodeDetail(withMember(name, value)),
        new RegExp(`^lease item member ${name} is ${escape(shown)};`),
      );
    }
  });

  it('refuses non-finite versions by name (A-05)', () => {
    for (const [value, shown] of [
      [Number.POSITIVE_INFINITY, 'Infinity'],
      [Number.NEGATIVE_INFINITY, '-Infinity'],
      [Number.NaN, 'NaN'],
    ] as const) {
      assert.equal(
        decodeDetail(withMember('lease_version', value)),
        `lease item member lease_version is number ${shown}; expected a positive safe integer`,
      );
    }
  });

  it('refuses a 100k-deep value with a bounded message instead of overflowing the stack (A-05)', () => {
    const detail = decodeDetail(withMember('owner_id', deepArray(100_000)));
    assert.match(detail, /^lease item member owner_id is array \[\[\[\[/);
    assert.match(detail, /…\[truncated\]; expected a lowercase UUIDv4$/);
    assert.ok(detail.length < 1_000, `detail of ${String(detail.length)} characters; expected a bounded message`);
    const unknown = decodeDetail(withMember('nested', deepArray(100_000)));
    assert.match(unknown, /unknown member string "nested"/);
  });

  it('quotes a long unknown member name only up to the kernel bound', () => {
    const detail = decodeDetail(withMember('x'.repeat(10_000), 1));
    assert.match(detail, /…\[truncated\]; expected only pk/);
    assert.ok(detail.length < 1_000);
  });
});

describe('isOwnedBy', () => {
  const item = leaseItem(RUN_OWNER, EPOCH_UTC);

  it('holds for the same kind, identity and manifest digest', () => {
    assert.equal(isOwnedBy(item, RUN_OWNER), true);
    assert.equal(isOwnedBy(item, leaseOwnerOf(RUN_EXECUTION, RUN_MANIFEST_SHA)), true);
  });

  it('fails when any of the three differs', () => {
    assert.equal(isOwnedBy(item, { ...RUN_OWNER, owner_kind: 'VARIANT_VALIDATION' }), false);
    assert.equal(isOwnedBy(item, { ...RUN_OWNER, owner_id: FOREIGN_OWNER.owner_id }), false);
    assert.equal(isOwnedBy(item, { ...RUN_OWNER, owner_manifest_sha256: OTHER_MANIFEST_SHA }), false);
  });
});

describe('isLeaseAvailable', () => {
  it('holds for no item and for an explicitly released item', () => {
    assert.equal(isLeaseAvailable(undefined), true);
    assert.equal(isLeaseAvailable(leaseItem(FOREIGN_OWNER, EPOCH_UTC, { lease_status: 'RELEASED' })), true);
  });

  it('never holds for a held or recovery-required item, however long expired', () => {
    assert.equal(isLeaseAvailable(leaseItem(FOREIGN_OWNER, PAST, { expires_at: PAST })), false);
    assert.equal(isLeaseAvailable(leaseItem(FOREIGN_OWNER, PAST, { lease_status: 'RECOVERY_REQUIRED' })), false);
  });
});

describe('describeHolder and leaseReason', () => {
  it('name the holder, status, version and expiry', () => {
    assert.equal(
      describeHolder(leaseItem(FOREIGN_OWNER, EPOCH_UTC, { lease_version: 4 })),
      `TRANSPORT_PROBE ${FOREIGN_OWNER.owner_id} (manifest ${OTHER_MANIFEST_SHA}) HELD at version 4, expires_at 2026-10-05T12:05:00.000Z`,
    );
  });

  it('build a BR-RUA-045 reason', () => {
    assert.deepEqual(leaseReason('LEASE_STALE', 'late'), {
      code: 'LEASE_STALE',
      subject: 'BR-RUA-045',
      detail: 'late',
    });
  });
});

describe('leaseOwnerOf', () => {
  it('takes the execution kind, its id and the manifest digest', () => {
    assert.deepEqual(leaseOwnerOf(RUN_EXECUTION, RUN_MANIFEST_SHA), RUN_OWNER);
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
