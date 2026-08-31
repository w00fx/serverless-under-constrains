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

  const heartbeatMs = parseHeartbeat(item.heartbeat);
  if (item.heartbeat !== undefined && item.heartbeat !== null && heartbeatMs === undefined) {
    return "unverified";
  }
  if (heartbeatMs !== undefined && now.getTime() - heartbeatMs < STALE_BOUNDARY_MS) {
    return "non_stale";
  }

  const ownerId = classifyOwnerField(item.owner_id);
  const ownerKind = classifyOwnerField(item.owner_kind);
  if (ownerId === "invalid" || ownerKind === "invalid") {
    return "unverified";
  }
  const ownerPresent = ownerId === "valid" || ownerKind === "valid";
  if (status !== "released" && ownerPresent) {
    return "active";
  }
  if (status !== "released") {
    return "unverified";
  }

  return "allow";
}

function classifyOwnerField(value: unknown): "absent" | "valid" | "invalid" {
  if (value === undefined) {
    return "absent";
  }
  return trimmedIdentity(value) === undefined ? "invalid" : "valid";
}

function parseHeartbeat(value: unknown): number | undefined {
  return isUtcMillisecondTimestamp(value) ? Date.parse(value) : undefined;
}

