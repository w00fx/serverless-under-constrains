// Integrity checks over built fixture bytes, written from BR-RUA-033 and BR-RUA-034 rather than
// from the builder: every record parses and is schema-valid, event ids are unique, sequences are
// dense from 1 per source instance, causation resolves inside the execution scope, and every
// digest a record holds is the digest of the bytes it names. A base fixture must pass all of them;
// a case's fault breaks exactly the ones it states.

import { createHash } from 'node:crypto';

import { isCanonicalCausation } from '../../../src/record-contract/envelope.ts';
import { isJsonObject } from '../../../src/record-contract/json-value.ts';
import { parseJsonDocument, parseJsonl } from '../../../src/record-contract/parsing.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import type { RecordValidator } from '../../../src/record-contract/schema-registry.ts';
import type { FixtureBytes } from './digest-links.ts';
import { recordText } from './golden-event-log.ts';

/** One parsed record and the file it came from. */
export interface LocatedRecord {
  readonly path: string;
  readonly record: JsonObject;
}

/**
 * Parses every file into records; unparseable files and non-object records are problems.
 *
 * @example
 * const { records, problems } = parseFixtureRecords(bytes);
 */
export function parseFixtureRecords(files: FixtureBytes): {
  readonly records: readonly LocatedRecord[];
  readonly problems: readonly string[];
} {
  const records: LocatedRecord[] = [];
  const problems: string[] = [];
  for (const [path, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const values = path.endsWith('.jsonl')
      ? parseJsonl(bytes).lines.map((line) => line.parsed)
      : [parseJsonDocument(bytes)];
    const parsedRecords = values.map((value) => (value.ok && isJsonObject(value.value) ? value.value : undefined));
    records.push(...parsedRecords.flatMap((record) => (record === undefined ? [] : [{ path, record }])));
    problems.push(
      ...parsedRecords
        .filter((record) => record === undefined)
        .map(() => `${path}: a line or document is not a JSON object; expected a record`),
    );
  }
  return { records, problems };
}

/**
 * Every integrity problem of a fixture; empty for a sound base.
 *
 * @example
 * fixtureIntegrityProblems(bytes, createRecordValidator()); // []
 */
export function fixtureIntegrityProblems(files: FixtureBytes, validator: RecordValidator): readonly string[] {
  const parsed = parseFixtureRecords(files);
  const events = parsed.records.filter(({ record }) => typeof record['event_id'] === 'string');
  return [
    ...parsed.problems,
    ...parsed.records.flatMap(({ path, record }) => schemaProblems(path, record, validator)),
    ...eventIdProblems(events),
    ...sequenceProblems(events),
    ...causationProblems(events),
    ...digestProblems(files, parsed.records),
  ];
}

function schemaProblems(path: string, record: JsonObject, validator: RecordValidator): readonly string[] {
  const validation = validator.validate(record);
  return validation.valid
    ? []
    : [
        `${path}: ${recordText(record, 'record_type')} violates its schema: ${JSON.stringify(validation.violations.slice(0, 3))}`,
      ];
}

function eventIdProblems(events: readonly LocatedRecord[]): readonly string[] {
  const seen = new Set<string>();
  return events.flatMap(({ path, record }) => {
    const eventId = recordText(record, 'event_id');
    const repeated = seen.has(eventId);
    seen.add(eventId);
    return repeated ? [`${path}: event_id ${eventId} appears twice; expected unique event ids`] : [];
  });
}

// BR-RUA-033: dense from 1 within each (source, source_instance_id), across every journal.
function sequenceProblems(events: readonly LocatedRecord[]): readonly string[] {
  const byInstance = new Map<string, number[]>();
  for (const { record } of events) {
    const key = `${recordText(record, 'source')}#${recordText(record, 'source_instance_id')}`;
    byInstance.set(key, [...(byInstance.get(key) ?? []), Number(record['source_sequence'])]);
  }
  return [...byInstance].flatMap(([key, sequences]) => {
    const sorted = sequences.toSorted((a, b) => a - b);
    const dense = sorted.every((sequence, index) => sequence === index + 1);
    return dense ? [] : [`${key}: sequences ${JSON.stringify(sorted)}; expected 1..${String(sorted.length)}`];
  });
}

function causationProblems(events: readonly LocatedRecord[]): readonly string[] {
  const known = new Set(events.map(({ record }) => recordText(record, 'event_id')));
  return events.flatMap(({ path, record }) => {
    const causation = record['causation_event_ids'];
    if (causation === undefined) {
      return [];
    }
    const ids: readonly JsonValue[] = Array.isArray(causation) ? causation : [];
    const unresolved = ids.filter((id) => typeof id !== 'string' || !known.has(id));
    const eventId = recordText(record, 'event_id');
    return [
      ...(isCanonicalCausation(ids) ? [] : [`${path}: ${eventId} causation is not sorted and unique`]),
      ...unresolved.map((id) => `${path}: ${eventId} names unresolved predecessor ${JSON.stringify(id)}`),
    ];
  });
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const md5 = (bytes: Uint8Array): string => createHash('md5').update(bytes).digest('hex');

// BR-RUA-033 digests over exact stored bytes (design §8.2 I3 core-file digests).
function digestProblems(files: FixtureBytes, records: readonly LocatedRecord[]): readonly string[] {
  const digestOf = (path: string): string | undefined => {
    const bytes = files.get(path);
    return bytes === undefined ? undefined : sha256(bytes);
  };
  const expectEqual = (
    where: string,
    field: string,
    actual: JsonValue | undefined,
    expected: string | undefined,
  ): readonly string[] =>
    actual === undefined || actual === expected
      ? []
      : [`${where}: ${field} ${JSON.stringify(actual)}; expected the digest ${String(expected)} of the bytes it names`];
  const executionDigest = digestOf('admission/execution-manifest.json');
  return records.flatMap(({ path, record }) => {
    const trialDirectory = trialDirectoryOf(path, record);
    const trialManifest = `${trialDirectory}/trial-manifest.json`;
    return [
      ...expectEqual(path, 'execution_manifest_sha256', record['execution_manifest_sha256'], executionDigest),
      ...expectEqual(path, 'trial_manifest_sha256', record['trial_manifest_sha256'], digestOf(trialManifest)),
      ...expectEqual(
        path,
        'resource_manifest_sha256',
        record['resource_manifest_sha256'],
        digestOf('provisioning/resource-manifest.json'),
      ),
      ...expectEqual(
        path,
        'payment_sha256',
        record['payment_sha256'],
        digestOf(`${trialDirectory}/inputs/payment.json`),
      ),
      ...expectEqual(
        path,
        'approved_decision_sha256',
        record['approved_decision_sha256'],
        digestOf(`${trialDirectory}/inputs/approved-decision.json`),
      ),
      ...messageDigestProblems(files, path, record, trialDirectory),
    ];
  });
}

// A record's trial directory: its own for a file under `trials/<t>/`, else the trial it names.
function trialDirectoryOf(path: string, record: JsonObject): string {
  const match = /^trials\/[^/]+/.exec(path);
  return match === null ? `trials/${recordText(record, 'trial_id')}` : match[0];
}

function messageDigestProblems(
  files: FixtureBytes,
  path: string,
  record: JsonObject,
  trialDirectory: string,
): readonly string[] {
  if (record['record_type'] === 'dlq_snapshot') {
    return dlqBodyProblems(path, record);
  }
  if (record['record_type'] !== 'trial_message_published') {
    return [];
  }
  const message = files.get(`${trialDirectory}/inputs/published-message.json`);
  const sameSha = message !== undefined && record['message_body_sha256'] === sha256(message);
  const sameMd5 = message !== undefined && record['md5_of_message_body'] === md5(message);
  return sameSha && sameMd5
    ? []
    : [`${path}: trial_message_published digests do not match the published message bytes`];
}

// SQS reports `MD5OfBody` and the collector its SHA-256 over the exact body bytes.
function dlqBodyProblems(path: string, record: JsonObject): readonly string[] {
  const messages = Array.isArray(record['messages']) ? (record['messages'] as readonly JsonValue[]) : [];
  return messages.flatMap((message, index) => {
    const fields: JsonObject = isJsonObject(message) ? message : {};
    const body = encoder.encode(recordText(fields, 'body'));
    const matches = fields['body_sha256'] === sha256(body) && fields['md5_of_body'] === md5(body);
    return matches ? [] : [`${path}: messages[${String(index)}] body digests do not match its body bytes`];
  });
}

const encoder = new TextEncoder();
