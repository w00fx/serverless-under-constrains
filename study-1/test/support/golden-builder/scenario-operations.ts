// Model-level scenario operations (design §12.4 "the scenario-builder operations"): edits to the
// built records before serialization, so digest links still resolve over the edited bytes. A case
// states a fault as the smallest edit that produces it: one member set or removed, one record
// removed, inserted or duplicated, a file added. Paths are package-relative; `$trial/` names the
// subject trial's directory. Every operation returns a result naming the offending value and the
// expected shape instead of throwing.

import { classifyArtifactPath } from '../../../src/record-contract/evidence-refs.ts';
import { boundedJsonText, isJsonObject } from '../../../src/record-contract/json-value.ts';
import type { JsonValue, Result } from '../../../src/record-contract/primitives.ts';
import type { FixtureFileContent, ScenarioFiles } from './digest-links.ts';
import { mapStrings } from './digest-links.ts';
import { memberOf, removeAtPointer, setAtPointer } from './json-pointer.ts';

/** Names one record of a JSONL file: the nth of a type (1-based), an event id, or a 1-based line. */
export type RecordSelector =
  | { readonly record_type: string; readonly occurrence?: number }
  | { readonly event_id: string }
  | { readonly line: number };

/** One member assignment of a cloned record. */
export interface PointerAssignment {
  readonly pointer: string;
  readonly value: JsonValue;
}

export type ModelOperation =
  | {
      readonly op: 'set';
      readonly path: string;
      readonly select?: RecordSelector;
      readonly pointer: string;
      readonly value: JsonValue;
    }
  | { readonly op: 'remove'; readonly path: string; readonly select?: RecordSelector; readonly pointer: string }
  | { readonly op: 'remove_record'; readonly path: string; readonly select: RecordSelector }
  | { readonly op: 'insert_record'; readonly path: string; readonly record: JsonValue; readonly after?: RecordSelector }
  | {
      readonly op: 'clone_record';
      readonly path: string;
      readonly select: RecordSelector;
      readonly set: readonly PointerAssignment[];
    }
  | { readonly op: 'resequence'; readonly path: string }
  | { readonly op: 'put_file'; readonly path: string; readonly content: FixtureFileContent };

export const MODEL_OPERATION_NAMES = [
  'set',
  'remove',
  'remove_record',
  'insert_record',
  'clone_record',
  'resequence',
  'put_file',
] as const;

/** The alias a case uses for the subject trial's directory. */
export const SUBJECT_ALIAS = '$trial/';

type FileMap = Map<string, FixtureFileContent>;

/**
 * Applies operations in order to a copy of the files; the first failing operation stops the run
 * and is reported with its position.
 *
 * @example
 * applyModelOperations(files, [{ op: 'remove_record', path: '$trial/journals/caller-journal.jsonl', select: { line: 2 } }], 'trials/t');
 */
export function applyModelOperations(
  files: ScenarioFiles,
  operations: readonly ModelOperation[],
  subjectDirectory: string,
): Result<ScenarioFiles, string> {
  const edited: FileMap = new Map(files);
  for (const [index, operation] of operations.entries()) {
    const applied = applyOne(edited, expandOperation(operation, subjectDirectory));
    if (!applied.ok) {
      return { ok: false, error: `operation ${String(index + 1)} (${operation.op}): ${applied.error}` };
    }
  }
  return { ok: true, value: edited };
}

/**
 * Replaces the `$trial/` alias at the start of a path, or of a digest link's target.
 *
 * @example
 * expandSubjectAlias('$trial/ledger/ledger-snapshot.json', 'trials/t'); // 'trials/t/ledger/ledger-snapshot.json'
 * expandSubjectAlias('@sha256($trial/inputs/payment.json)', 'trials/t'); // '@sha256(trials/t/inputs/payment.json)'
 */
export function expandSubjectAlias(text: string, subjectDirectory: string): string {
  if (text.startsWith(SUBJECT_ALIAS)) {
    return `${subjectDirectory}/${text.slice(SUBJECT_ALIAS.length)}`;
  }
  return text.replace(/^(@(?:sha256|md5|text)\()\$trial\//, `$1${subjectDirectory}/`);
}

function expandOperation(operation: ModelOperation, subjectDirectory: string): ModelOperation {
  const expand = (value: JsonValue): JsonValue =>
    mapStrings(value, (text) => expandSubjectAlias(text, subjectDirectory));
  const path = expandSubjectAlias(operation.path, subjectDirectory);
  switch (operation.op) {
    case 'set':
      return { ...operation, path, value: expand(operation.value) };
    case 'insert_record':
      return { ...operation, path, record: expand(operation.record) };
    case 'clone_record':
      return {
        ...operation,
        path,
        set: operation.set.map((assignment) => ({ ...assignment, value: expand(assignment.value) })),
      };
    case 'put_file':
      return { ...operation, path, content: expandContent(operation.content, expand) };
    case 'remove':
    case 'remove_record':
    case 'resequence':
      return { ...operation, path };
  }
}

function expandContent(content: FixtureFileContent, expand: (value: JsonValue) => JsonValue): FixtureFileContent {
  return content.kind === 'json'
    ? { kind: 'json', record: expand(content.record) }
    : { kind: 'jsonl', records: content.records.map(expand) };
}

function applyOne(files: FileMap, operation: ModelOperation): Result<null, string> {
  const violation = classifyArtifactPath(operation.path);
  if (violation !== undefined) {
    return {
      ok: false,
      error: `path ${boundedJsonText(operation.path)} is ${violation}; expected a normalized package-relative path`,
    };
  }
  if (operation.op === 'put_file') {
    files.set(operation.path, operation.content);
    return { ok: true, value: null };
  }
  const content = files.get(operation.path);
  if (content === undefined) {
    return {
      ok: false,
      error: `the scenario holds no file ${boundedJsonText(operation.path)}; expected an existing fixture file`,
    };
  }
  const edited = editContent(content, operation);
  if (!edited.ok) {
    return edited;
  }
  files.set(operation.path, edited.value);
  return { ok: true, value: null };
}

function editContent(
  content: FixtureFileContent,
  operation: Exclude<ModelOperation, { readonly op: 'put_file' }>,
): Result<FixtureFileContent, string> {
  switch (operation.op) {
    case 'set':
      return editRecord(content, operation.select, (record) =>
        setAtPointer(record, operation.pointer, operation.value),
      );
    case 'remove':
      return editRecord(content, operation.select, (record) => removeAtPointer(record, operation.pointer));
    case 'remove_record':
      return editLines(content, (records) => removeRecord(records, operation.select));
    case 'insert_record':
      return editLines(content, (records) => insertRecord(records, operation.record, operation.after));
    case 'clone_record':
      return editLines(content, (records) => cloneRecord(records, operation.select, operation.set));
    case 'resequence':
      return editLines(content, (records) => ({ ok: true, value: resequence(records) }));
  }
}

type RecordEdit = (record: JsonValue) => Result<JsonValue, string>;
type LinesEdit = (records: readonly JsonValue[]) => Result<readonly JsonValue[], string>;

function editRecord(
  content: FixtureFileContent,
  select: RecordSelector | undefined,
  edit: RecordEdit,
): Result<FixtureFileContent, string> {
  if (content.kind === 'json') {
    if (select !== undefined) {
      return { ok: false, error: 'a JSON file holds one record; expected no select' };
    }
    const edited = edit(content.record);
    return edited.ok ? { ok: true, value: { kind: 'json', record: edited.value } } : edited;
  }
  if (select === undefined) {
    return { ok: false, error: 'a JSONL file holds many records; expected a select naming one' };
  }
  return editLines(content, (records) => {
    const selected = selectRecord(records, select);
    if (!selected.ok) {
      return selected;
    }
    const edited = edit(selected.value.record);
    return edited.ok ? { ok: true, value: records.with(selected.value.index, edited.value) } : edited;
  });
}

function editLines(content: FixtureFileContent, edit: LinesEdit): Result<FixtureFileContent, string> {
  if (content.kind === 'json') {
    return { ok: false, error: 'the operation edits JSONL lines; expected a .jsonl file' };
  }
  const edited = edit(content.records);
  return edited.ok ? { ok: true, value: { kind: 'jsonl', records: edited.value } } : edited;
}

/** A selected record and its 0-based line index. */
export interface SelectedRecord {
  readonly index: number;
  readonly record: JsonValue;
}

/**
 * The record a selector names, with its 0-based index.
 *
 * @example
 * selectRecord(records, { record_type: 'dispatch_started', occurrence: 2 }); // { ok: true, value: { index: 7, record } }
 */
export function selectRecord(records: readonly JsonValue[], select: RecordSelector): Result<SelectedRecord, string> {
  const index = indexOfSelection(records, select);
  const record = records[index];
  return record === undefined
    ? { ok: false, error: `no record matches selector ${boundedJsonText(select)}; expected exactly one match` }
    : { ok: true, value: { index, record } };
}

function indexOfSelection(records: readonly JsonValue[], select: RecordSelector): number {
  if ('line' in select) {
    return Number.isSafeInteger(select.line) && select.line >= 1 && select.line <= records.length
      ? select.line - 1
      : -1;
  }
  if ('event_id' in select) {
    return records.findIndex((record) => memberOf(record, 'event_id') === select.event_id);
  }
  const wanted = select.occurrence ?? 1;
  let seen = 0;
  return records.findIndex((record) => {
    seen += memberOf(record, 'record_type') === select.record_type ? 1 : 0;
    return seen === wanted && memberOf(record, 'record_type') === select.record_type;
  });
}

function removeRecord(records: readonly JsonValue[], select: RecordSelector): Result<readonly JsonValue[], string> {
  const selected = selectRecord(records, select);
  return selected.ok ? { ok: true, value: records.toSpliced(selected.value.index, 1) } : selected;
}

function insertRecord(
  records: readonly JsonValue[],
  record: JsonValue,
  after: RecordSelector | undefined,
): Result<readonly JsonValue[], string> {
  if (after === undefined) {
    return { ok: true, value: [...records, record] };
  }
  const selected = selectRecord(records, after);
  return selected.ok ? { ok: true, value: records.toSpliced(selected.value.index + 1, 0, record) } : selected;
}

function cloneRecord(
  records: readonly JsonValue[],
  select: RecordSelector,
  assignments: readonly PointerAssignment[],
): Result<readonly JsonValue[], string> {
  const selected = selectRecord(records, select);
  if (!selected.ok) {
    return selected;
  }
  let clone: Result<JsonValue, string> = { ok: true, value: selected.value.record };
  for (const assignment of assignments) {
    if (!clone.ok) {
      return clone;
    }
    clone = setAtPointer(clone.value, assignment.pointer, assignment.value);
  }
  return clone.ok ? { ok: true, value: records.toSpliced(selected.value.index + 1, 0, clone.value) } : clone;
}

// Dense `source_sequence` from 1 per (source, source_instance_id), in line order: what a writer
// would have assigned had the edited lines been the only appends (BR-RUA-033).
function resequence(records: readonly JsonValue[]): readonly JsonValue[] {
  const next = new Map<string, number>();
  return records.map((record) => {
    const source = memberOf(record, 'source');
    const instance = memberOf(record, 'source_instance_id');
    if (!isJsonObject(record) || typeof source !== 'string' || typeof instance !== 'string') {
      return record;
    }
    const key = `${source}#${instance}`;
    const sequence = (next.get(key) ?? 0) + 1;
    next.set(key, sequence);
    // Object spread defines members, so an own `__proto__` member stays an own member.
    return { ...record, source_sequence: sequence };
  });
}
