// The Study/account/Region lease item of the baseline coordination table (BR-RUA-045; design
// §9.1, §10.3). The coordination table lives in one account and one Region, so one item per
// study is the whole lease: `pk = lease#study-1`, `sk = current`.
//
// Ownership is the owner kind, owner identity and owner-manifest digest, together with the
// lease version (a fencing counter that every conditional write raises by one), the last
// confirmed heartbeat and the informational expiry. The table has no TTL attribute, so
// `expires_at` never deletes the item and never proves release: release exists only as a
// conditional `lease_status = RELEASED` write by the owner (AC-RUA-033, [R-aws] TTL).
//
// Items come back from the store as untrusted JSON (an operator, a defect or another tool may
// have written them), so `decodeLeaseItem` is total: it reads own members only, rejects
// non-finite numbers and unknown members (a closed item, A-07), and quotes offending values
// through the bounded kernel helper (A-05).

import type { ItemKey, StoredItem } from '../durable-store/item-store-port.ts';
import { isSha256Hex } from '../record-contract/digests.ts';
import { isUuid4 } from '../record-contract/identifiers.ts';
import { describeJson } from '../record-contract/json-value.ts';
import type {
  ExecutionKind,
  JsonValue,
  Result,
  Sha256Hex,
  StructuredReason,
  Uuid4,
  UtcMillis,
} from '../record-contract/primitives.ts';
import { EXECUTION_KINDS } from '../record-contract/primitives.ts';
import { formatUtcMillis, isUtcMillis } from '../record-contract/timestamps.ts';

/** The layout version of the coordination table items; the coordination stack declares it too. */
export const COORDINATION_SCHEMA_VERSION = 1;

/** The one lease item of Study 1 in this account and Region. */
export const LEASE_ITEM_KEY: ItemKey = { pk: 'lease#study-1', sk: 'current' };

/** Lifecycle of the stored lease; a domain enum, so uppercase (BR-RUA-033). */
export const LEASE_ITEM_STATUSES = ['HELD', 'RELEASED', 'RECOVERY_REQUIRED'] as const;
export type LeaseItemStatus = (typeof LEASE_ITEM_STATUSES)[number];

/** The stale boundary after the last confirmed heartbeat (BR-RUA-045); also sets `expires_at`. */
export const LEASE_STALE_BOUNDARY_MS = 300_000;

/** The subject of every reason this feature produces. */
export const LEASE_RULE = 'BR-RUA-045';

/** The closed reason codes of the coordination lease. */
export const LEASE_REASON_CODES = {
  conflict: 'LEASE_CONFLICT',
  itemAbsent: 'LEASE_ITEM_ABSENT',
  itemUndecodable: 'LEASE_ITEM_UNDECODABLE',
  readFailed: 'LEASE_READ_FAILED',
  writeRejected: 'LEASE_WRITE_REJECTED',
  writeAmbiguous: 'LEASE_WRITE_AMBIGUOUS',
  ownershipMismatch: 'LEASE_OWNERSHIP_MISMATCH',
  stale: 'LEASE_STALE',
} as const;

/** Who holds or asks for the lease (BR-RUA-045 "owner kind, owner identity, owner-manifest digest"). */
export interface LeaseOwner {
  readonly owner_kind: ExecutionKind;
  readonly owner_id: Uuid4;
  readonly owner_manifest_sha256: Sha256Hex;
}

/** A decoded lease item. */
export interface LeaseItem extends LeaseOwner {
  readonly pk: string;
  readonly sk: string;
  readonly coordination_schema_version: typeof COORDINATION_SCHEMA_VERSION;
  readonly lease_status: LeaseItemStatus;
  /** Raised by one on every conditional write; a positive safe integer. */
  readonly lease_version: number;
  readonly acquired_at: UtcMillis;
  /** The last confirmed heartbeat (the acquisition counts as the first). */
  readonly heartbeat_at: UtcMillis;
  /** `heartbeat_at` plus the stale boundary; informational only, never a release. */
  readonly expires_at: UtcMillis;
  readonly updated_at: UtcMillis;
}

type LeaseItemMember = keyof LeaseItem;

// Every member of the closed item, each with the check of its value.
const MEMBER_CHECKS: Readonly<Record<LeaseItemMember, (value: JsonValue) => boolean>> = {
  pk: (value) => value === LEASE_ITEM_KEY.pk,
  sk: (value) => value === LEASE_ITEM_KEY.sk,
  coordination_schema_version: (value) => value === COORDINATION_SCHEMA_VERSION,
  lease_status: (value) => (LEASE_ITEM_STATUSES as readonly JsonValue[]).includes(value),
  owner_kind: (value) => (EXECUTION_KINDS as readonly JsonValue[]).includes(value),
  owner_id: isUuid4,
  owner_manifest_sha256: isSha256Hex,
  lease_version: (value) => Number.isSafeInteger(value) && (value as number) >= 1,
  acquired_at: isUtcMillis,
  heartbeat_at: isUtcMillis,
  expires_at: isUtcMillis,
  updated_at: isUtcMillis,
};

const MEMBER_EXPECTATIONS: Readonly<Record<LeaseItemMember, string>> = {
  pk: `"${LEASE_ITEM_KEY.pk}"`,
  sk: `"${LEASE_ITEM_KEY.sk}"`,
  coordination_schema_version: String(COORDINATION_SCHEMA_VERSION),
  lease_status: `one of ${LEASE_ITEM_STATUSES.join(', ')}`,
  owner_kind: `one of ${EXECUTION_KINDS.join(', ')}`,
  owner_id: 'a lowercase UUIDv4',
  owner_manifest_sha256: '64 lowercase hex digits',
  lease_version: 'a positive safe integer',
  acquired_at: 'a UTC instant YYYY-MM-DDTHH:mm:ss.SSSZ',
  heartbeat_at: 'a UTC instant YYYY-MM-DDTHH:mm:ss.SSSZ',
  expires_at: 'a UTC instant YYYY-MM-DDTHH:mm:ss.SSSZ',
  updated_at: 'a UTC instant YYYY-MM-DDTHH:mm:ss.SSSZ',
};

const MEMBERS = Object.keys(MEMBER_CHECKS) as readonly LeaseItemMember[];
const MEMBER_SET: ReadonlySet<string> = new Set(MEMBERS);

/**
 * Decodes a stored item into a lease item, or explains the first defect. Total over any JSON
 * object: own members only, no unknown member, every value checked without recursion.
 *
 * @example
 * const decoded = decodeLeaseItem(stored);
 * if (!decoded.ok) report(decoded.error); // { code: 'LEASE_ITEM_UNDECODABLE', … }
 */
export function decodeLeaseItem(item: StoredItem): Result<LeaseItem, StructuredReason> {
  const unknown = Object.keys(item).find((name) => !MEMBER_SET.has(name));
  if (unknown !== undefined) {
    return undecodable(`unknown member ${describeJson(unknown)}; expected only ${MEMBERS.join(', ')}`);
  }
  for (const member of MEMBERS) {
    const value = Object.hasOwn(item, member) ? item[member] : undefined;
    if (value === undefined || !MEMBER_CHECKS[member](value)) {
      return undecodable(`member ${member} is ${describeJson(value)}; expected ${MEMBER_EXPECTATIONS[member]}`);
    }
  }
  return { ok: true, value: item as unknown as LeaseItem };
}

/**
 * Whether the item names exactly this owner: kind, identity and manifest digest.
 *
 * @example
 * isOwnedBy(item, owner); // false for another execution, or the same id under another manifest
 */
export function isOwnedBy(item: LeaseItem, owner: LeaseOwner): boolean {
  return (
    item.owner_kind === owner.owner_kind &&
    item.owner_id === owner.owner_id &&
    item.owner_manifest_sha256 === owner.owner_manifest_sha256
  );
}

/**
 * Whether a new owner may acquire: no item, or an item explicitly released. An expired
 * `expires_at` never makes a held lease available (TTL expiry never establishes release).
 *
 * @example
 * isLeaseAvailable(undefined); // true
 * isLeaseAvailable({ ...item, lease_status: 'HELD', expires_at: pastInstant }); // false
 */
export function isLeaseAvailable(item: LeaseItem | undefined): boolean {
  return item === undefined || item.lease_status === 'RELEASED';
}

/**
 * The item a fresh acquisition writes: version 1, held, heartbeat and acquisition at `at`.
 *
 * @example
 * acquiredLeaseItem(owner, '2026-10-05T12:00:00.000Z' as UtcMillis).expires_at; // '2026-10-05T12:05:00.000Z'
 */
export function acquiredLeaseItem(owner: LeaseOwner, at: UtcMillis): LeaseItem {
  return {
    ...LEASE_ITEM_KEY,
    coordination_schema_version: COORDINATION_SCHEMA_VERSION,
    lease_status: 'HELD',
    owner_kind: owner.owner_kind,
    owner_id: owner.owner_id,
    owner_manifest_sha256: owner.owner_manifest_sha256,
    lease_version: 1,
    acquired_at: at,
    heartbeat_at: at,
    expires_at: leaseExpiry(at),
    updated_at: at,
  };
}

/**
 * The informational expiry of a heartbeat at `at`: `at` plus the stale boundary.
 *
 * @example
 * leaseExpiry('2026-10-05T12:00:00.000Z' as UtcMillis); // '2026-10-05T12:05:00.000Z'
 */
export function leaseExpiry(at: UtcMillis): UtcMillis {
  return formatUtcMillis(new Date(Date.parse(at) + LEASE_STALE_BOUNDARY_MS));
}

/**
 * The stored form of a lease item.
 *
 * @example
 * await store.write({ kind: 'put', table: 'coordination', item: toStoredItem(acquiredLeaseItem(owner, at)) });
 */
export function toStoredItem(item: LeaseItem): StoredItem {
  return { ...item };
}

/**
 * Names the holder and status an item shows, for reasons and journal details.
 *
 * @example
 * describeHolder(item); // 'RUN 3f1c…-… (manifest abcd…) RELEASED at version 4, expires_at 2026-10-05T12:05:00.000Z'
 */
export function describeHolder(item: LeaseItem): string {
  return `${item.owner_kind} ${item.owner_id} (manifest ${item.owner_manifest_sha256}) ${item.lease_status} at version ${String(item.lease_version)}, expires_at ${item.expires_at}`;
}

/**
 * A reason of this feature, with the BR-RUA-045 subject.
 *
 * @example
 * leaseReason('LEASE_STALE', 'last confirmed 300000 ms ago; expected less than 300000 ms');
 */
export function leaseReason(code: string, detail: string): StructuredReason {
  return { code, subject: LEASE_RULE, detail };
}

function undecodable(detail: string): { readonly ok: false; readonly error: StructuredReason } {
  return { ok: false, error: leaseReason(LEASE_REASON_CODES.itemUndecodable, `lease item ${detail}`) };
}
