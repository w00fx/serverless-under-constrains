import {
  isRecord,
  isUtcMillisecondTimestamp,
  trimmedIdentity,
} from "../protocol-records/primitives.ts";
import {
  isExpectedCoordinationSchemaVersion,
  STALE_BOUNDARY_MS,
} from "./identity.ts";
import type { LeaseItem } from "./types.ts";

export type DestroyLeaseVerdict =
  | "allow"
  | "active"
  | "non_stale"
  | "recovery_required"
  | "unverified";

const HEARTBEAT_INVALID = 0;
const HEARTBEAT_NOT_FRESH = 1;
const HEARTBEAT_FRESH = 2;

const OWNER_ABSENT = 0;
const OWNER_PRESENT = 1;
const OWNER_INVALID = 2;

export function classifyLeaseForDestroy(
  item: LeaseItem,
  now: Date,
): DestroyLeaseVerdict {
  if (!isRecord(item)) {
    return "unverified";
  }

  if (typeof item.lease_key !== "string" || item.lease_key.trim() === "") {
    return "unverified";
  }
  if (!isExpectedCoordinationSchemaVersion(item.schema_version)) {
    return "unverified";
  }

  const status = item.lease_status;
  if (status === "recovery_required") {
    return "recovery_required";
  }
  if (status !== undefined && status !== "released") {
    return "unverified";
  }

  const heartbeat = readHeartbeat(item.heartbeat, now);
  if (heartbeat === HEARTBEAT_INVALID) {
    return "unverified";
  }
  if (heartbeat === HEARTBEAT_FRESH) {
    return "non_stale";
  }

  const ownerId = readOwnerField(item.owner_id);
  const ownerKind = readOwnerField(item.owner_kind);
  if (ownerId === OWNER_INVALID || ownerKind === OWNER_INVALID) {
    return "unverified";
  }
  if (status !== "released") {
    return ownerId === OWNER_PRESENT || ownerKind === OWNER_PRESENT
      ? "active"
      : "unverified";
  }

  return "allow";
}

function readHeartbeat(value: unknown, now: Date): number {
  if (value === undefined || value === null) {
    return HEARTBEAT_NOT_FRESH;
  }
  if (!isUtcMillisecondTimestamp(value)) {
    return HEARTBEAT_INVALID;
  }
  return now.getTime() - Date.parse(value) < STALE_BOUNDARY_MS
    ? HEARTBEAT_FRESH
    : HEARTBEAT_NOT_FRESH;
}

function readOwnerField(value: unknown): number {
  if (value === undefined) {
    return OWNER_ABSENT;
  }
  if (trimmedIdentity(value) === undefined) {
    return OWNER_INVALID;
  }
  return OWNER_PRESENT;
}
