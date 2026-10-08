// The coordination prefix checkpoint (BR-RUA-044): a probe's coordination journal stays open
// through cleanup, so at transport freeze the probe evidence index hashes a checkpoint of the
// journal's prefix instead of the open file: the path, the prefix byte count, the prefix digest,
// the last included event and its sequence, and the checkpoint time. The final package index then
// hashes the complete journal, whose first `prefix_byte_count` bytes must still be that prefix.
//
// The prefix is the journal up to and including its last newline: a line still being appended is
// not yet an event, so it is never part of the frozen prefix. The last included event is read from
// the bytes themselves rather than taken on trust from the caller.

import { sha256Hex } from '../record-contract/digests.ts';
import { isUuid4 } from '../record-contract/identifiers.ts';
import { boundedJsonText, isJsonObject } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, Sha256Hex, StructuredReason, Uuid4, UtcMillis } from '../record-contract/primitives.ts';
import type { CoordinationPrefixCheckpoint } from '../record-contract/records/group-b/coordination_prefix_checkpoint.ts';
import { EXECUTION_PATHS } from './package-layout.ts';

export interface PrefixCheckpointInput {
  /** The coordination journal bytes as read at transport freeze. */
  readonly journal: Uint8Array;
  readonly transport_probe_id: Uuid4;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly checkpointed_at: UtcMillis;
}

/** The event that closes a journal prefix. */
export interface PrefixLastEvent {
  readonly event_id: Uuid4;
  readonly source_sequence: number;
}

const NEWLINE = 0x0a;

/**
 * Builds the checkpoint of the journal's complete-line prefix, or the reason it cannot: no
 * complete line, or a last line that is not an event with an id and a positive sequence.
 *
 * @example
 * const checkpoint = buildPrefixCheckpoint({ journal, transport_probe_id, execution_manifest_sha256, checkpointed_at });
 * if (checkpoint.ok) await fs.writeOnce(`${dir}/coordination/coordination-prefix-checkpoint.json`, serializeRecordFile(checkpoint.value));
 */
export function buildPrefixCheckpoint(
  input: PrefixCheckpointInput,
): Result<CoordinationPrefixCheckpoint, StructuredReason> {
  const prefixLength = input.journal.lastIndexOf(NEWLINE) + 1;
  const prefix = input.journal.subarray(0, prefixLength);
  const last = lastPrefixEvent(prefix);
  if (!last.ok) {
    return err({
      code: 'PREFIX_LAST_EVENT_UNREADABLE',
      subject: 'BR-RUA-044',
      artifact_path: EXECUTION_PATHS.coordinationJournal,
      detail: last.error,
    });
  }
  return ok({
    schema_version: 1,
    record_type: 'coordination_prefix_checkpoint',
    transport_probe_id: input.transport_probe_id,
    execution_manifest_sha256: input.execution_manifest_sha256,
    journal_path: EXECUTION_PATHS.coordinationJournal,
    prefix_byte_count: prefixLength,
    prefix_sha256: sha256Hex(prefix),
    last_event_id: last.value.event_id,
    last_source_sequence: last.value.source_sequence,
    checkpointed_at: input.checkpointed_at,
  });
}

/**
 * Checks that the complete journal still starts with the checkpointed prefix: the byte count fits,
 * the digest of those bytes matches, and the prefix still ends with the checkpointed event.
 * Returns the problem, or `undefined` when the checkpoint holds.
 *
 * @example
 * const problem = checkPrefixCheckpoint(checkpoint, finalJournalBytes);
 */
export function checkPrefixCheckpoint(
  checkpoint: CoordinationPrefixCheckpoint,
  journal: Uint8Array,
): string | undefined {
  if (checkpoint.prefix_byte_count > journal.length) {
    return `prefix_byte_count ${String(checkpoint.prefix_byte_count)} exceeds the ${String(journal.length)}-byte journal; expected the journal to extend its prefix`;
  }
  const prefix = journal.subarray(0, checkpoint.prefix_byte_count);
  if (sha256Hex(prefix) !== checkpoint.prefix_sha256) {
    return `the first ${String(checkpoint.prefix_byte_count)} journal bytes hash to ${sha256Hex(prefix)}; expected prefix_sha256 ${checkpoint.prefix_sha256}`;
  }
  const last = lastPrefixEvent(prefix);
  const matches =
    last.ok &&
    last.value.event_id === checkpoint.last_event_id &&
    last.value.source_sequence === checkpoint.last_source_sequence;
  return matches
    ? undefined
    : `the prefix does not end with event ${checkpoint.last_event_id} at sequence ${String(checkpoint.last_source_sequence)}; expected the checkpointed last event`;
}

/**
 * The event on the last line of a newline-terminated prefix, or why it cannot be read.
 *
 * @example
 * lastPrefixEvent(new TextEncoder().encode('{"event_id":"…","source_sequence":1}\n'));
 */
export function lastPrefixEvent(prefix: Uint8Array): Result<PrefixLastEvent, string> {
  if (prefix.length === 0) {
    return err('the journal has no complete line; expected at least one newline-terminated event');
  }
  const lineStart = prefix.lastIndexOf(NEWLINE, prefix.length - 2) + 1;
  const parsed = parseJsonDocument(prefix.subarray(lineStart, prefix.length - 1));
  const line = parsed.ok ? parsed.value : undefined;
  const eventId = isJsonObject(line) && Object.hasOwn(line, 'event_id') ? line['event_id'] : undefined;
  const sequence = isJsonObject(line) && Object.hasOwn(line, 'source_sequence') ? line['source_sequence'] : undefined;
  if (!isUuid4(eventId) || !isSourceSequence(sequence)) {
    const shown = line === undefined ? 'not one UTF-8 JSON document' : boundedJsonText(line);
    return err(
      `the last complete line is ${shown}; expected an event with a lowercase UUIDv4 event_id and a positive safe-integer source_sequence`,
    );
  }
  return ok({ event_id: eventId, source_sequence: sequence });
}

function isSourceSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}
