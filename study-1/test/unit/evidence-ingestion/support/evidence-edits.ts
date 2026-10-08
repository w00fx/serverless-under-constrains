// Record-level edits of an ingestion input for the gate suites: append a schema-valid event to a
// subject journal under a fresh source instance (so its sequence stays dense), derived from an
// event already in that journal.

import type { IngestionInput } from '../../../../src/evidence-ingestion/ingestion-model.ts';
import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import { artifactValues, jsonl, withArtifact } from './evidence-fixtures.ts';

/** The envelope members an appended event copies from the journal's first event. */
const ENVELOPE_MEMBERS = [
  'schema_version',
  'run_id',
  'variant_validation_id',
  'transport_probe_id',
  'execution_manifest_sha256',
  'trial_id',
  'trial_manifest_sha256',
  'occurred_at',
  'source',
] as const;

/**
 * The input with a new event appended to `path`: the envelope of the journal's first event, a
 * fresh event id and source instance at sequence 1, no causal predecessors, then `members`.
 *
 * @example
 * appendEvent(input, callerPath, { record_type: 'trial_message_rejected', ... });
 */
export function appendEvent(
  input: IngestionInput,
  path: string,
  members: Readonly<Record<string, JsonValue>>,
): IngestionInput {
  const values = artifactValues(input, path);
  const [first] = values;
  if (first === null || typeof first !== 'object' || Array.isArray(first)) {
    throw new Error(`${path} has no first event; expected a journal with events`);
  }
  const source = first as Readonly<Record<string, JsonValue>>;
  const head = Object.fromEntries(
    ENVELOPE_MEMBERS.filter((member) => Object.hasOwn(source, member)).map((member) => [
      member,
      source[member] ?? null,
    ]),
  );
  const event = {
    ...head,
    event_id: '9d9d9d9d-9d9d-4d9d-8d9d-9d9d9d9d9d9d',
    source_instance_id: '8c8c8c8c-8c8c-4c8c-8c8c-8c8c8c8c8c8c',
    source_sequence: 1,
    ...members,
  };
  return withArtifact(input, path, jsonl([...values, event]));
}

/**
 * The members of a `trial_message_rejected` with the given reason, laid over a caller event.
 *
 * @example
 * appendEvent(input, callerPath, rejection('NO_ACTIVE_TRIAL'));
 */
export function rejection(reason: string): Readonly<Record<string, JsonValue>> {
  const keep = { message_id: 'message-1', message_body_sha256: 'f'.repeat(64), reason, detail: 'rejected' };
  return { record_type: 'trial_message_rejected', ...keep };
}
