import { fail, ok, type ValidationResult } from "./result.ts";
import type { PackageStore, PrefixCheckpoint } from "./types.ts";
import { decodeUtf8 } from "./utf8.ts";
import { CHECKPOINT_PATH, JOURNAL_PATH } from "./paths.ts";
import { storeBytes } from "./store.ts";
import { sha256Hex } from "../protocol-records/serialize.ts";
import {
  isPositiveSafeInteger,
  isRecord,
  isSha256Hex,
  isUtcMillisecondTimestamp,
  isUuidV4,
} from "../protocol-records/primitives.ts";

const CHECKPOINT_FIELDS = [
  "schema_version",
  "record_type",
  "path",
  "prefix_byte_count",
  "prefix_digest",
  "last_included_event_id",
  "last_included_sequence",
  "checkpoint_time",
] as const;

export function createPrefixCheckpoint(input: unknown): ValidationResult<PrefixCheckpoint> {
  if (isRecord(input) === false) {
    return fail(["not_an_object"]);
  }
  const problems: string[] = [];
  for (const field of Object.keys(input)) {
    if ((CHECKPOINT_FIELDS as readonly string[]).includes(field) === false) {
      problems.push("unknown_property");
    }
  }
  if (input.schema_version !== 1) {
    problems.push("invalid_schema_version");
  }
  if (input.record_type !== "coordination_prefix_checkpoint") {
    problems.push("invalid_record_type");
  }
  if (input.path !== JOURNAL_PATH) {
    problems.push("invalid_path");
  }
  if (isPositiveSafeInteger(input.prefix_byte_count) === false) {
    problems.push("invalid_byte_count");
  }
  if (isSha256Hex(input.prefix_digest) === false) {
    problems.push("invalid_sha256");
  }
  if (isUuidV4(input.last_included_event_id) === false) {
    problems.push("invalid_uuid");
  }
  if (isPositiveSafeInteger(input.last_included_sequence) === false) {
    problems.push("invalid_sequence");
  }
  if (isUtcMillisecondTimestamp(input.checkpoint_time) === false) {
    problems.push("invalid_timestamp");
  }
  return problems.length === 0
    ? ok({
        schema_version: 1,
        record_type: "coordination_prefix_checkpoint",
        path: JOURNAL_PATH,
        prefix_byte_count: input.prefix_byte_count as number,
        prefix_digest: input.prefix_digest as string,
        last_included_event_id: input.last_included_event_id as string,
        last_included_sequence: input.last_included_sequence as number,
        checkpoint_time: input.checkpoint_time as string,
      })
    : fail(problems);
}

function parseJsonlObjects(text: string): unknown[] | undefined {
  try {
    return text.slice(0, -1).split("\n").map((line) => JSON.parse(line));
  } catch {
    return undefined;
  }
}

export function lastJournalEvent(objects: readonly unknown[]): { event_id: string; source_sequence: number } | undefined {
  const last = objects[objects.length - 1];
  if (!isRecord(last) || !isUuidV4(last.event_id) || !isPositiveSafeInteger(last.source_sequence)) {
    return undefined;
  }
  return { event_id: last.event_id, source_sequence: last.source_sequence };
}

export function validateCheckpointAgainstJournal(
  checkpoint: PrefixCheckpoint,
  journal: Uint8Array,
): ValidationResult<PrefixCheckpoint> {
  if (checkpoint.prefix_byte_count > journal.byteLength) {
    return fail(["checkpoint_prefix_mismatch"]);
  }
  const prefix = journal.subarray(0, checkpoint.prefix_byte_count);
  if (sha256Hex(prefix) !== checkpoint.prefix_digest) {
    return fail(["checkpoint_prefix_mismatch"]);
  }
  const text = decodeUtf8(prefix);
  if (text === undefined || !text.endsWith("\n")) {
    return fail(["malformed_checkpoint"]);
  }
  const objects = parseJsonlObjects(text);
  if (objects === undefined) {
    return fail(["malformed_checkpoint"]);
  }
  const last = lastJournalEvent(objects);
  if (
    last === undefined ||
    last.event_id !== checkpoint.last_included_event_id ||
    last.source_sequence !== checkpoint.last_included_sequence
  ) {
    return fail(["checkpoint_prefix_mismatch"]);
  }
  return ok(checkpoint);
}

export function readCheckpoint(bytes: Uint8Array): ValidationResult<PrefixCheckpoint> {
  try {
    return createPrefixCheckpoint(JSON.parse(String(decodeUtf8(bytes))));
  } catch {
    return fail(["malformed_checkpoint"]);
  }
}

export function checkpointAlignmentReasons(
  store: PackageStore,
): { reasons: string[]; hasCheckpoint: boolean } {
  const bytes = storeBytes(store, CHECKPOINT_PATH);
  if (bytes === undefined) {
    return { reasons: [], hasCheckpoint: false };
  }
  const reasons: string[] = [];
  const journal = storeBytes(store, JOURNAL_PATH);
  const checkpoint = readCheckpoint(bytes);
  if (!checkpoint.ok) {
    reasons.push("malformed_checkpoint");
  }
  if (journal === undefined) {
    reasons.push("missing_file");
  } else if (checkpoint.ok) {
    const aligned = validateCheckpointAgainstJournal(checkpoint.value, journal);
    if (!aligned.ok) {
      reasons.push(...aligned.reasons);
    }
  }
  return { reasons, hasCheckpoint: true };
}
