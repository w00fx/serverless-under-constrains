import { randomUUID } from "node:crypto";

const LOWERCASE_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_UTC_MILLISECOND =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const CANONICAL_RECORD_TYPE = /^[a-z][a-z0-9_]*$/;

export class TerminalProbeIdentityError extends Error {
  readonly probe_attempt_id: string;
  readonly existing_outcome: "rejected" | "frozen";

  constructor(probeAttemptId: string, existingOutcome: "rejected" | "frozen") {
    super("probe attempt identity already has a terminal admission outcome");
    this.name = "TerminalProbeIdentityError";
    this.probe_attempt_id = probeAttemptId;
    this.existing_outcome = existingOutcome;
  }
}

export function formatUtcTimestamp(date: Date): string {
  return date.toISOString();
}

export function isLowercaseUuidV4(value: string): boolean {
  return LOWERCASE_UUID_V4.test(value);
}

export function resolveLowercaseUuidV4(createId: (() => string) | undefined): string {
  const id = createId?.() ?? randomUUID();
  if (!isLowercaseUuidV4(id)) {
    throw new Error("probe attempt identity must be a lowercase UUIDv4");
  }
  return id;
}

export function isCanonicalUtcMillisecondTimestamp(value: string): boolean {
  if (!CANONICAL_UTC_MILLISECOND.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  return parsed.toISOString() === value;
}

export function isCanonicalRecordType(value: string): boolean {
  return CANONICAL_RECORD_TYPE.test(value);
}
