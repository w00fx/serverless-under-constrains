// Parses the `operations` of an untrusted case value into typed scenario operations, reporting
// every malformed field with its location, the offending value and the expected shape. Paths are
// checked against BR-RUA-035 after the `$trial/` alias is accepted; pointers against RFC 6901.

import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import type { ByteOperation } from './byte-operations.ts';
import { BYTE_OPERATION_NAMES } from './byte-operations.ts';
import type { Problems } from './case-reading.ts';
import { readArray, readChoice, readInteger, readJson, readMember, readObject, readString } from './case-reading.ts';
import type { FixtureFileContent } from './digest-links.ts';
import { parsePointer } from './json-pointer.ts';
import type { ModelOperation, PointerAssignment, RecordSelector } from './scenario-operations.ts';
import { MODEL_OPERATION_NAMES } from './scenario-operations.ts';

/** Any scenario operation a case may list, model-level or byte-level. */
export type ScenarioOperation = ModelOperation | ByteOperation;

const OPERATION_NAMES = [...MODEL_OPERATION_NAMES, ...BYTE_OPERATION_NAMES] as const;
type OperationName = (typeof OPERATION_NAMES)[number];

/** Package-relative path, optionally starting with the subject alias; never empty. */
const PATH_PATTERN = /^\S(.*\S)?$/u;
const RECORD_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;
const ANY_TEXT = /^[\s\S]*$/u;

/** The member names each operation declares besides `op` and `path`. */
const OPERATION_FIELDS: Readonly<Record<OperationName, readonly [readonly string[], readonly string[]]>> = {
  set: [['pointer', 'value'], ['select']],
  remove: [['pointer'], ['select']],
  remove_record: [['select'], []],
  insert_record: [['record'], ['after']],
  clone_record: [['select', 'set'], []],
  resequence: [[], []],
  put_file: [['content'], []],
  delete_file: [[], []],
  corrupt_byte: [['offset', 'byte'], []],
  append_text: [['text'], []],
  truncate: [['length'], []],
};

/**
 * Parses an operations list; undefined after reporting problems.
 *
 * @example
 * parseOperations([{ op: 'delete_file', path: '$trial/ledger/ledger-snapshot.json' }], 'case.operations', problems);
 */
export function parseOperations(
  value: unknown,
  at: string,
  problems: Problems,
): readonly ScenarioOperation[] | undefined {
  const items = readArray(value, at, problems);
  if (items === undefined) {
    return undefined;
  }
  const before = problems.length;
  const operations = items.map((item, index) => parseOperation(item, `${at}[${String(index)}]`, problems));
  const parsed = operations.filter((operation): operation is ScenarioOperation => operation !== undefined);
  return problems.length === before && parsed.length === items.length ? parsed : undefined;
}

function parseOperation(value: unknown, at: string, problems: Problems): ScenarioOperation | undefined {
  // The first read only finds `op`; the second, with the operation's own members, reports.
  const headProblems: Problems = [];
  const head = readObject(value, at, ['op', 'path'], allOperationFields(), headProblems);
  if (head === undefined) {
    problems.push(...headProblems);
    return undefined;
  }
  const name = readChoice(head.get('op'), `${at}.op`, OPERATION_NAMES, problems);
  if (name === undefined) {
    return undefined;
  }
  const [required, optional] = OPERATION_FIELDS[name];
  const before = problems.length;
  const fields = readObject(value, at, ['op', 'path', ...required], optional, problems);
  const path = readString(head.get('path'), `${at}.path`, PATH_PATTERN, problems);
  if (fields === undefined || path === undefined || problems.length > before) {
    return undefined;
  }
  return buildOperation(name, path, fields, at, problems);
}

function allOperationFields(): readonly string[] {
  return [...new Set(Object.values(OPERATION_FIELDS).flatMap(([required, optional]) => [...required, ...optional]))];
}

function buildOperation(
  name: OperationName,
  path: string,
  fields: ReadonlyMap<string, unknown>,
  at: string,
  problems: Problems,
): ScenarioOperation | undefined {
  const field = (key: string): unknown => fields.get(key);
  const optionalSelect = (key: string): RecordSelector | undefined | null =>
    fields.has(key) ? (parseSelector(field(key), `${at}.${key}`, problems) ?? null) : undefined;
  switch (name) {
    case 'set': {
      const pointer = parsePointerField(field('pointer'), `${at}.pointer`, problems);
      const value = readJson(field('value'), `${at}.value`, problems);
      const select = optionalSelect('select');
      return pointer === undefined || value === undefined || select === null
        ? undefined
        : { op: name, path, pointer, value, ...(select === undefined ? {} : { select }) };
    }
    case 'remove': {
      const pointer = parsePointerField(field('pointer'), `${at}.pointer`, problems);
      const select = optionalSelect('select');
      return pointer === undefined || select === null
        ? undefined
        : { op: name, path, pointer, ...(select === undefined ? {} : { select }) };
    }
    case 'remove_record': {
      const select = parseSelector(field('select'), `${at}.select`, problems);
      return select === undefined ? undefined : { op: name, path, select };
    }
    case 'insert_record': {
      const record = readJson(field('record'), `${at}.record`, problems);
      const after = optionalSelect('after');
      return record === undefined || after === null
        ? undefined
        : { op: name, path, record, ...(after === undefined ? {} : { after }) };
    }
    case 'clone_record': {
      const select = parseSelector(field('select'), `${at}.select`, problems);
      const assignments = parseAssignments(field('set'), `${at}.set`, problems);
      return select === undefined || assignments === undefined
        ? undefined
        : { op: name, path, select, set: assignments };
    }
    case 'put_file': {
      const content = parseContent(field('content'), `${at}.content`, problems);
      return content === undefined ? undefined : { op: name, path, content };
    }
    case 'resequence':
    case 'delete_file':
      return { op: name, path };
    case 'corrupt_byte': {
      const offset = readInteger(field('offset'), `${at}.offset`, 0, problems);
      const byte = readInteger(field('byte'), `${at}.byte`, 0, problems);
      return offset === undefined || byte === undefined ? undefined : { op: name, path, offset, byte };
    }
    case 'append_text': {
      const text = readString(field('text'), `${at}.text`, ANY_TEXT, problems);
      return text === undefined ? undefined : { op: name, path, text };
    }
    case 'truncate': {
      const length = readInteger(field('length'), `${at}.length`, 0, problems);
      return length === undefined ? undefined : { op: name, path, length };
    }
  }
}

function parsePointerField(value: unknown, at: string, problems: Problems): string | undefined {
  const pointer = readString(value, at, ANY_TEXT, problems);
  if (pointer === undefined) {
    return undefined;
  }
  const parsed = parsePointer(pointer);
  if (!parsed.ok) {
    problems.push(`${at}: ${parsed.error}`);
    return undefined;
  }
  return pointer;
}

/**
 * Parses a record selector: `{record_type, occurrence?}`, `{event_id}` or `{line}`.
 *
 * @example
 * parseSelector({ record_type: 'dispatch_started' }, 'op.select', problems); // { record_type: 'dispatch_started' }
 */
export function parseSelector(value: unknown, at: string, problems: Problems): RecordSelector | undefined {
  const probe: Problems = [];
  const fields = readObject(value, at, [], ['record_type', 'occurrence', 'event_id', 'line'], probe);
  if (fields === undefined || probe.length > 0) {
    problems.push(...probe);
    return undefined;
  }
  const keys = [...fields.keys()].sort().join(',');
  switch (keys) {
    case 'record_type':
    case 'occurrence,record_type': {
      const recordType = readString(fields.get('record_type'), `${at}.record_type`, RECORD_TYPE_PATTERN, problems);
      const occurrence = fields.has('occurrence')
        ? readInteger(fields.get('occurrence'), `${at}.occurrence`, 1, problems)
        : 1;
      return recordType === undefined || occurrence === undefined ? undefined : { record_type: recordType, occurrence };
    }
    case 'event_id': {
      const eventId = readString(fields.get('event_id'), `${at}.event_id`, ANY_TEXT, problems);
      return eventId === undefined ? undefined : { event_id: eventId };
    }
    case 'line': {
      const line = readInteger(fields.get('line'), `${at}.line`, 1, problems);
      return line === undefined ? undefined : { line };
    }
    default:
      problems.push(`${at} has members [${keys}]; expected {record_type, occurrence?}, {event_id} or {line}`);
      return undefined;
  }
}

function parseAssignments(value: unknown, at: string, problems: Problems): readonly PointerAssignment[] | undefined {
  const items = readArray(value, at, problems);
  if (items === undefined) {
    return undefined;
  }
  const before = problems.length;
  const assignments = items.map((item, index): PointerAssignment | undefined => {
    const itemAt = `${at}[${String(index)}]`;
    const fields = readObject(item, itemAt, ['pointer', 'value'], [], problems);
    if (fields === undefined) {
      return undefined;
    }
    const pointer = readMember(fields, 'pointer', (raw) => parsePointerField(raw, `${itemAt}.pointer`, problems));
    const assigned = readMember(fields, 'value', (raw) => readJson(raw, `${itemAt}.value`, problems));
    return pointer === undefined || assigned === undefined ? undefined : { pointer, value: assigned };
  });
  const parsed = assignments.filter((assignment): assignment is PointerAssignment => assignment !== undefined);
  return problems.length === before ? parsed : undefined;
}

function parseContent(value: unknown, at: string, problems: Problems): FixtureFileContent | undefined {
  const fields = readObject(value, at, ['kind'], ['record', 'records'], problems);
  if (fields === undefined) {
    return undefined;
  }
  const kind = readMember(fields, 'kind', (raw) => readChoice(raw, `${at}.kind`, ['json', 'jsonl'] as const, problems));
  if (kind === undefined) {
    return undefined;
  }
  if (kind === 'json') {
    const record = fields.has('records') ? undefined : readJson(fields.get('record'), `${at}.record`, problems);
    if (fields.has('records')) {
      problems.push(`${at} of kind json has records; expected one record`);
    }
    return record === undefined ? undefined : { kind, record };
  }
  const records = fields.has('record') ? undefined : readArray(fields.get('records'), `${at}.records`, problems);
  if (fields.has('record')) {
    problems.push(`${at} of kind jsonl has record; expected records`);
  }
  const checked = records?.map((record, index) => readJson(record, `${at}.records[${String(index)}]`, problems));
  return checked === undefined || checked.some((record) => record === undefined)
    ? undefined
    : { kind, records: checked as readonly JsonValue[] };
}
