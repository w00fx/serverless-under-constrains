import {
  fail,
  isPositiveSafeInteger,
  isRecord,
  isSha256Hex,
  isUtcMillisecondTimestamp,
  isUuidV4,
  ok,
  ownKeys,
  RECORD_TYPE,
  REJECTED_ALIASES,
  trimmedIdentity,
} from "./primitives.ts";
import { structuralKey } from "./serialize.ts";
import type { EventSequenceReport, PrimaryEvent, ValidationResult } from "./types.ts";

const RESERVED = new Set(
  "schema_version record_type event_id occurred_at source source_instance_id source_sequence causation_event_ids trial_manifest_sha256 run_id transport_probe_id variant_validation_id".split(
    " ",
  ),
);

const BINDING_KEYS = ["run_id", "transport_probe_id", "variant_validation_id"] as const;

function createCausation(value: unknown, reasons: string[]): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    reasons.push("invalid_causation");
    return undefined;
  }
  if (value.length === 0) {
    return undefined;
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isUuidV4(item) || seen.has(item)) {
      reasons.push("invalid_causation");
      return undefined;
    }
    seen.add(item);
    ids.push(item);
  }
  return ids.toSorted();
}

export function createPrimaryEvent(input: unknown): ValidationResult<PrimaryEvent> {
  if (!isRecord(input)) {
    return fail(["not_an_object"]);
  }
  const reasons: string[] = [];
  for (const key of ownKeys(input)) {
    if (REJECTED_ALIASES.includes(key)) {
      reasons.push("alias_rejected");
    }
  }
  if (input.schema_version !== 1) {
    reasons.push("invalid_schema_version");
  }
  if (typeof input.record_type !== "string" || !RECORD_TYPE.test(input.record_type)) {
    reasons.push("invalid_record_type");
  }
  if (!isUuidV4(input.event_id)) {
    reasons.push("invalid_uuid");
  }
  if (!isUtcMillisecondTimestamp(input.occurred_at)) {
    reasons.push("invalid_timestamp");
  }
  const source = trimmedIdentity(input.source);
  if (source === undefined) {
    reasons.push(typeof input.source === "string" ? "empty_identity" : "invalid_identifier");
  }
  if (!isUuidV4(input.source_instance_id)) {
    reasons.push("invalid_uuid");
  }
  if (!isPositiveSafeInteger(input.source_sequence)) {
    reasons.push("invalid_sequence");
  }
  if (!isSha256Hex(input.trial_manifest_sha256)) {
    reasons.push("invalid_sha256");
  }
  const bindings = BINDING_KEYS.filter((key) => input[key] !== undefined);
  if (bindings.length === 0) {
    reasons.push("missing_execution_binding");
  } else if (bindings.length > 1) {
    reasons.push("ambiguous_execution_binding");
  } else if (!isUuidV4(input[bindings[0]!])) {
    reasons.push("invalid_uuid");
  }
  const causation = createCausation(input.causation_event_ids, reasons);
  if (reasons.length > 0) {
    return fail(reasons);
  }
  const event: PrimaryEvent = {
    schema_version: 1,
    record_type: input.record_type as string,
    event_id: input.event_id as string,
    occurred_at: input.occurred_at as string,
    source: source as string,
    source_instance_id: input.source_instance_id as string,
    source_sequence: input.source_sequence as number,
    trial_manifest_sha256: input.trial_manifest_sha256 as string,
  };
  const bindingKey = bindings[0]!;
  event[bindingKey] = input[bindingKey] as string;
  if (causation !== undefined) {
    event.causation_event_ids = causation;
  }
  for (const key of ownKeys(input)) {
    if (!RESERVED.has(key) && !REJECTED_ALIASES.includes(key) && input[key] !== undefined) {
      // Plain assignment would invoke the inherited `__proto__` setter instead of
      // creating an own property, silently dropping the value or replacing the
      // prototype of the record being built.
      Object.defineProperty(event, key, {
        enumerable: true,
        value: input[key],
      });
    }
  }
  return ok(event);
}

function instanceKey(event: PrimaryEvent): string {
  return `${event.source}\n${event.source_instance_id}`;
}

function sequenceKey(event: PrimaryEvent): string {
  return `${instanceKey(event)}\n${event.source_sequence}`;
}

export function classifyEventSequence(input: unknown): ValidationResult<EventSequenceReport> {
  if (!Array.isArray(input)) {
    return fail(["not_an_object"]);
  }
  const created = input.map((item) => createPrimaryEvent(item));
  const reasons = created.flatMap((item) => (item.ok ? [] : [...item.reasons]));
  if (reasons.length > 0) {
    return fail(reasons);
  }
  const events = created.map((item) => (item as { ok: true; value: PrimaryEvent }).value);
  const byEventId = new Map<string, string>();
  const bySequence = new Map<string, string>();
  const instances = new Map<string, Set<number>>();
  const presentIds = new Set(events.map((event) => event.event_id));
  let equivalentDuplicates = 0;
  const contentConflicts: string[] = [];
  const sequenceConflicts: string[] = [];
  const gaps: string[] = [];
  const missingCausation: string[] = [];
  for (const event of events) {
    const key = structuralKey(event);
    if (!key.ok) {
      return key;
    }
    const previous = byEventId.get(event.event_id);
    if (previous === undefined) {
      byEventId.set(event.event_id, key.value);
    } else if (previous === key.value) {
      equivalentDuplicates += 1;
    } else if (!contentConflicts.includes(event.event_id)) {
      contentConflicts.push(event.event_id);
    }
    const seqId = sequenceKey(event);
    const previousSeq = bySequence.get(seqId);
    if (previousSeq === undefined) {
      bySequence.set(seqId, event.event_id);
    } else if (previousSeq !== event.event_id && !sequenceConflicts.includes(seqId)) {
      sequenceConflicts.push(seqId);
    }
    const instance = instanceKey(event);
    const tracked = instances.get(instance) ?? new Set<number>();
    tracked.add(event.source_sequence);
    instances.set(instance, tracked);
    for (const predecessor of event.causation_event_ids ?? []) {
      if (!presentIds.has(predecessor) && !missingCausation.includes(predecessor)) {
        missingCausation.push(predecessor);
      }
    }
  }
  // A dense instance holding `n` sequences is exactly 1..n, so any absence in
  // that window proves the instance is not dense. Walking to the highest
  // observed sequence instead would scale with the sequence value rather than
  // the event count, and a single valid safe integer would exhaust memory.
  for (const [instance, observed] of instances) {
    for (let sequence = 1; sequence <= observed.size; sequence += 1) {
      if (!observed.has(sequence)) {
        gaps.push(`${instance}\n${sequence}`);
      }
    }
  }
  return ok({
    equivalent_duplicates: equivalentDuplicates,
    content_conflicts: contentConflicts,
    sequence_conflicts: sequenceConflicts,
    gaps,
    missing_causation: missingCausation,
  });
}
