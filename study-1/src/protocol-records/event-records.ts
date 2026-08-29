import { omitUndefinedAndSort } from "./serialize.ts";
import {
  isCanonicalRecordType,
  isCanonicalUtcMillisecondTimestamp,
  isLowercaseUuidV4,
  isPlainObject,
  isPositiveSafeSequence,
  isSha256Hex,
  trimmedIdentifier,
} from "./primitives.ts";
import {
  pushIdentifier,
  pushSchemaVersion,
  requirePlainObject,
} from "./records.ts";
import {
  EXECUTION_IDENTITY_KEYS,
  SCHEMA_VERSION,
  type PrimaryEvent,
  type RejectionReason,
  type ValidationResult,
} from "./types.ts";

const ENVELOPE_REQUIRED_KEYS = [
  "schema_version",
  "record_type",
  "event_id",
  "occurred_at",
  "source",
  "source_instance_id",
  "source_sequence",
  "trial_manifest_sha256",
] as const;

export function createPrimaryEvent(input: unknown): ValidationResult<PrimaryEvent> {
  const objectResult = requirePlainObject(input);
  if (!objectResult.ok) {
    return objectResult;
  }
  const raw = objectResult.value;
  const reasons: RejectionReason[] = [];
  pushSchemaVersion(reasons, raw.schema_version);
  if (!isCanonicalRecordType(raw.record_type)) {
    reasons.push({
      code: "invalid_record_type",
      field: "record_type",
      expected: "lowercase record_type",
      observed: raw.record_type,
    });
  }
  if (!isLowercaseUuidV4(raw.event_id)) {
    reasons.push({
      code: "invalid_uuid",
      field: "event_id",
      expected: "lowercase UUIDv4",
      observed: raw.event_id,
    });
  }
  if (!isCanonicalUtcMillisecondTimestamp(raw.occurred_at)) {
    reasons.push({
      code: "invalid_timestamp",
      field: "occurred_at",
      expected: "UTC YYYY-MM-DDTHH:mm:ss.SSSZ",
      observed: raw.occurred_at,
    });
  }
  const source = pushIdentifier(reasons, "source", raw.source);
  if (!isLowercaseUuidV4(raw.source_instance_id)) {
    reasons.push({
      code: "invalid_uuid",
      field: "source_instance_id",
      expected: "lowercase UUIDv4",
      observed: raw.source_instance_id,
    });
  }
  if (!isPositiveSafeSequence(raw.source_sequence)) {
    reasons.push({
      code: "invalid_source_sequence",
      field: "source_sequence",
      expected: { min: 1, integer: true },
      observed: raw.source_sequence,
    });
  }
  if (!isSha256Hex(raw.trial_manifest_sha256)) {
    reasons.push({
      code: "invalid_sha256",
      field: "trial_manifest_sha256",
      expected: "lowercase 64-char hex",
      observed: raw.trial_manifest_sha256,
    });
  }

  const presentIdentities = EXECUTION_IDENTITY_KEYS.filter((key) => raw[key] !== undefined);
  if (presentIdentities.length !== 1) {
    reasons.push({
      code: "invalid_execution_identity",
      field: "execution_identity",
      expected: "exactly one of run_id, transport_probe_id, variant_validation_id",
      observed: presentIdentities,
    });
  } else {
    const identityKey = presentIdentities[0];
    if (identityKey !== undefined && !isLowercaseUuidV4(raw[identityKey])) {
      reasons.push({
        code: "invalid_uuid",
        field: identityKey,
        expected: "lowercase UUIDv4",
        observed: raw[identityKey],
      });
    }
  }

  const causation = validateCausationEventIds(raw.causation_event_ids, "causation_event_ids" in raw);
  if (!causation.ok) {
    reasons.push(...causation.reasons);
  }

  if (
    reasons.length > 0 ||
    source === undefined ||
    !isCanonicalRecordType(raw.record_type) ||
    !isLowercaseUuidV4(raw.event_id) ||
    !isCanonicalUtcMillisecondTimestamp(raw.occurred_at) ||
    !isLowercaseUuidV4(raw.source_instance_id) ||
    !isPositiveSafeSequence(raw.source_sequence) ||
    !isSha256Hex(raw.trial_manifest_sha256) ||
    presentIdentities.length !== 1 ||
    !causation.ok
  ) {
    return { ok: false, reasons };
  }

  const identityKey = presentIdentities[0];
  const identityValue = identityKey === undefined ? undefined : raw[identityKey];
  const event: PrimaryEvent = {
    schema_version: SCHEMA_VERSION,
    record_type: raw.record_type,
    event_id: raw.event_id,
    occurred_at: raw.occurred_at,
    source,
    source_instance_id: raw.source_instance_id,
    source_sequence: raw.source_sequence,
    trial_manifest_sha256: raw.trial_manifest_sha256,
  };
  if (identityKey !== undefined && isLowercaseUuidV4(identityValue)) {
    event[identityKey] = identityValue;
  }
  if (causation.value !== undefined) {
    event.causation_event_ids = causation.value;
  }
  const reserved = new Set<string>([
    ...ENVELOPE_REQUIRED_KEYS,
    ...EXECUTION_IDENTITY_KEYS,
    "causation_event_ids",
  ]);
  for (const [key, value] of Object.entries(raw)) {
    if (!reserved.has(key) && value !== undefined) {
      event[key] = value;
    }
  }
  return { ok: true, value: event };
}

export function classifyEventSequence(
  events: unknown,
): ValidationResult<{ duplicate_event_ids: Array<{ event_id: string; count: number }> }> {
  if (!Array.isArray(events)) {
    return {
      ok: false,
      reasons: [
        {
          code: "not_an_array",
          field: "events",
          expected: "array of events",
          observed: events === null ? null : typeof events,
        },
      ],
    };
  }

  const reasons: RejectionReason[] = [];
  const byEventId = new Map<string, { structural: string; count: number }>();
  const bySlot = new Map<string, { event_id: string; structural: string }>();
  const sequencesByInstance = new Map<string, Set<number>>();

  for (const [index, item] of events.entries()) {
    if (!isPlainObject(item)) {
      reasons.push({
        code: "not_an_object",
        field: `events[${index}]`,
        expected: "plain object",
        observed: item === null ? null : Array.isArray(item) ? "array" : typeof item,
      });
      continue;
    }
    if (!isLowercaseUuidV4(item.event_id)) {
      reasons.push({
        code: "invalid_uuid",
        field: `events[${index}].event_id`,
        expected: "lowercase UUIDv4",
        observed: item.event_id,
      });
    }
    const source = trimmedIdentifier(item.source);
    if (source === undefined) {
      reasons.push({
        code: "identifier_empty",
        field: `events[${index}].source`,
        expected: "nonempty identifier after trim",
        observed: item.source,
      });
    }
    if (!isLowercaseUuidV4(item.source_instance_id)) {
      reasons.push({
        code: "invalid_uuid",
        field: `events[${index}].source_instance_id`,
        expected: "lowercase UUIDv4",
        observed: item.source_instance_id,
      });
    }
    if (!isPositiveSafeSequence(item.source_sequence)) {
      reasons.push({
        code: "invalid_source_sequence",
        field: `events[${index}].source_sequence`,
        expected: { min: 1, integer: true },
        observed: item.source_sequence,
      });
    }
    if (
      !isLowercaseUuidV4(item.event_id) ||
      source === undefined ||
      !isLowercaseUuidV4(item.source_instance_id) ||
      !isPositiveSafeSequence(item.source_sequence)
    ) {
      continue;
    }

    const structural = JSON.stringify(omitUndefinedAndSort(item));
    const priorId = byEventId.get(item.event_id);
    if (priorId === undefined) {
      byEventId.set(item.event_id, { structural, count: 1 });
    } else if (priorId.structural === structural) {
      priorId.count += 1;
    } else {
      reasons.push({
        code: "event_id_conflict",
        field: `events[${index}].event_id`,
        expected: "structurally equivalent content for a repeated event_id",
        observed: item.event_id,
      });
    }

    const slot = `${source}\0${item.source_instance_id}\0${item.source_sequence}`;
    const priorSlot = bySlot.get(slot);
    if (priorSlot === undefined) {
      bySlot.set(slot, { event_id: item.event_id, structural });
    } else if (priorSlot.event_id !== item.event_id || priorSlot.structural !== structural) {
      reasons.push({
        code: "source_sequence_conflict",
        field: `events[${index}].source_sequence`,
        expected: "one event identity and content per source sequence",
        observed: {
          source,
          source_instance_id: item.source_instance_id,
          source_sequence: item.source_sequence,
        },
      });
    }

    const instanceKey = `${source}\0${item.source_instance_id}`;
    const sequences = sequencesByInstance.get(instanceKey) ?? new Set<number>();
    sequences.add(item.source_sequence);
    sequencesByInstance.set(instanceKey, sequences);
  }

  for (const [instanceKey, sequences] of sequencesByInstance.entries()) {
    const ordered = [...sequences].toSorted((left, right) => left - right);
    const expected = Array.from({ length: ordered.length }, (_, offset) => offset + 1);
    if (ordered.some((value, offset) => value !== expected[offset])) {
      const [source, sourceInstanceId] = instanceKey.split("\0");
      reasons.push({
        code: "source_sequence_gap",
        field: "source_sequence",
        expected,
        observed: { source, source_instance_id: sourceInstanceId, sequences: ordered },
      });
    }
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }

  const duplicate_event_ids = [...byEventId.entries()]
    .filter(([, entry]) => entry.count > 1)
    .map(([event_id, entry]) => ({ event_id, count: entry.count }))
    .toSorted((left, right) => left.event_id.localeCompare(right.event_id));

  return { ok: true, value: { duplicate_event_ids } };
}

function validateCausationEventIds(
  value: unknown,
  present: boolean,
): ValidationResult<string[] | undefined> {
  if (!present || value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: false,
      reasons: [
        {
          code: "invalid_causation_event_ids",
          field: "causation_event_ids",
          expected: "omitted for roots, or a nonempty sorted unique UUIDv4 array",
          observed: value,
        },
      ],
    };
  }
  const reasons: RejectionReason[] = [];
  for (const [index, id] of value.entries()) {
    if (!isLowercaseUuidV4(id)) {
      reasons.push({
        code: "invalid_uuid",
        field: `causation_event_ids[${index}]`,
        expected: "lowercase UUIDv4",
        observed: id,
      });
    }
  }
  if (new Set(value).size !== value.length) {
    reasons.push({
      code: "duplicate_causation_event_id",
      field: "causation_event_ids",
      expected: "unique UUIDv4 predecessors",
      observed: value,
    });
  }
  const allStrings = value.every((id) => typeof id === "string");
  const sorted = allStrings ? [...(value as string[])].toSorted((left, right) => left.localeCompare(right)) : [];
  if (sorted.length === value.length && value.some((id, index) => id !== sorted[index])) {
    reasons.push({
      code: "unsorted_causation_event_ids",
      field: "causation_event_ids",
      expected: sorted,
      observed: value,
    });
  }
  if (reasons.length > 0) {
    return { ok: false, reasons };
  }
  return { ok: true, value: value as string[] };
}
