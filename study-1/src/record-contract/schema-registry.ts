// Record validation against the catalogue schemas (AC-RUA-046). Schemas are discovered by
// directory (`schemas/<group>/<record_type>.schema.json`), so catalogue packages add files
// without touching a shared list. Ajv is created and each schema compiled lazily on first
// use, never at module load: a Lambda cold start pays nothing, and a broken schema fails the
// validation that needs it with a clear message instead of failing every import.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';

import { sha256Hex } from './digests.ts';
import { boundedJsonText, boundedText, isJsonObject } from './json-value.ts';
import { parseJsonDocument } from './parsing.ts';
import type { JsonObject, JsonValue, Sha256Hex } from './primitives.ts';
import { RECORD_GROUPS, RECORD_TYPE_GROUPS, isRecordType, recordGroupOf } from './record-types.ts';
import type { RecordType } from './record-types.ts';
import { findSchemaConventionViolations } from './schema-conventions.ts';
import { registerRecordVocabulary } from './schema-vocabulary.ts';
import type { StudyRecord } from './records/index.ts';

export const DEFAULT_SCHEMA_ROOT = fileURLToPath(new URL('./schemas/', import.meta.url));
const SCHEMA_SUFFIX = '.schema.json';

/**
 * The most characters a violation quotes from Ajv's instance path or params. Both mix schema
 * text, which reaches about 1,130 characters in the catalogue (the longest enum), with untrusted
 * member names: an additional or open-map property name is copied verbatim, so a 5 MB name once
 * made a 5 MB detail (WP-00 review round 2; Owner amendment A-05 policy 1).
 */
export const VIOLATION_TEXT_LIMIT = 2_000;

export interface SchemaViolation {
  readonly instance_path: string;
  readonly keyword: string;
  readonly detail: string;
}

export type RecordValidation =
  | { readonly valid: true; readonly record: StudyRecord }
  | { readonly valid: false; readonly record_type?: string; readonly violations: readonly SchemaViolation[] };

export interface RecordValidator {
  validate(value: JsonValue): RecordValidation;
  validateAs(type: RecordType, value: JsonValue): RecordValidation;
}

export interface SchemaFile {
  readonly record_type: RecordType;
  /** POSIX path relative to the schema root, e.g. `group-a/payment.schema.json`. */
  readonly relative_path: string;
  readonly sha256: Sha256Hex;
}

/**
 * The two filesystem reads the registry needs, injected so tests can control directory
 * order (readdir order is filesystem-specific: APFS returns names sorted, ext4 does not).
 */
export interface SchemaFileSystem {
  /** Entry names of a directory in the order the filesystem returns them, or undefined when it does not exist. */
  readonly listDirectory: (path: string) => readonly string[] | undefined;
  /** Exact bytes of a file, or undefined when it does not exist. */
  readonly readFile: (path: string) => Uint8Array | undefined;
}

/** The production `SchemaFileSystem` over `node:fs`. */
export const NODE_SCHEMA_FILE_SYSTEM: SchemaFileSystem = {
  listDirectory: (path) => (existsSync(path) ? readdirSync(path) : undefined),
  readFile: (path) => (existsSync(path) ? readFileSync(path) : undefined),
};

export interface SchemaLocation {
  /** Directory holding `group-a/`, `group-b/` and `group-c/`. */
  readonly schemaRoot?: string;
  /** Path of the shared definitions; defaults to `<schemaRoot>/_defs.schema.json`. */
  readonly defsPath?: string;
  /** Defaults to `NODE_SCHEMA_FILE_SYSTEM`. */
  readonly fileSystem?: SchemaFileSystem;
}

/**
 * Lists the schema files present, sorted by path, with the digest of their exact bytes.
 * A file whose name is not `<record_type>.schema.json` for a record type of its group is a
 * catalogue error and throws; dotfiles (such as `.DS_Store`) are ignored.
 *
 * @example
 * listSchemaFiles().map((file) => file.record_type); // ['environment_input', ...]
 */
export function listSchemaFiles(location: SchemaLocation = {}): readonly SchemaFile[] {
  const root = location.schemaRoot ?? DEFAULT_SCHEMA_ROOT;
  const fileSystem = location.fileSystem ?? NODE_SCHEMA_FILE_SYSTEM;
  return RECORD_GROUPS.flatMap((group) => {
    const directory = join(root, group);
    const names = (fileSystem.listDirectory(directory) ?? []).filter((name) => !name.startsWith('.')).toSorted();
    return names.map((name) => {
      const recordType = name.slice(0, -SCHEMA_SUFFIX.length);
      const listed: readonly string[] = RECORD_TYPE_GROUPS[group];
      if (!name.endsWith(SCHEMA_SUFFIX) || !listed.includes(recordType)) {
        throw new Error(
          `unexpected file ${join(directory, name)}; expected <record_type>${SCHEMA_SUFFIX} for a ${group} record type`,
        );
      }
      const relativePath = `${group}/${name}`;
      const bytes = fileSystem.readFile(join(root, relativePath));
      if (bytes === undefined) {
        throw new Error(
          `schema file ${join(root, relativePath)} was listed but cannot be read; expected a stable catalogue`,
        );
      }
      return { record_type: recordType as RecordType, relative_path: relativePath, sha256: sha256Hex(bytes) };
    });
  });
}

/**
 * Creates a validator over the catalogue schemas (Ajv 2020-12, strict, all errors).
 *
 * @example
 * const validator = createRecordValidator();
 * const checked = validator.validateAs('payment', parsed);
 * if (!checked.valid) reasons.push(...checked.violations.map(toReason));
 */
export function createRecordValidator(location: SchemaLocation = {}): RecordValidator {
  const root = location.schemaRoot ?? DEFAULT_SCHEMA_ROOT;
  const defsPath = location.defsPath ?? join(root, '_defs.schema.json');
  const fileSystem = location.fileSystem ?? NODE_SCHEMA_FILE_SYSTEM;
  const compiled = new Map<RecordType, ValidateFunction | undefined>();
  let ajv: Ajv2020 | undefined;

  const compilerFor = (recordType: RecordType): ValidateFunction | undefined => {
    if (!compiled.has(recordType)) {
      ajv ??= createAjv(fileSystem, defsPath);
      compiled.set(recordType, compileRecordSchema(ajv, fileSystem, root, recordType));
    }
    return compiled.get(recordType);
  };

  const validate = (value: JsonValue): RecordValidation => {
    if (!isJsonObject(value)) {
      return rejected(undefined, {
        instance_path: '',
        keyword: 'type',
        detail: `got ${boundedJsonText(value)}; expected a JSON object record`,
      });
    }
    const recordType = value['record_type'];
    if (!isRecordType(recordType)) {
      const shown = recordType === undefined ? 'absent' : boundedJsonText(recordType);
      const detail = `record_type ${shown} is not catalogued; expected one of RECORD_TYPES`;
      return rejected(typeof recordType === 'string' ? recordType : undefined, {
        instance_path: '/record_type',
        keyword: 'record_type',
        detail,
      });
    }
    const check = compilerFor(recordType);
    if (check === undefined) {
      const detail = `no schema at ${join(root, recordGroupOf(recordType), `${recordType}${SCHEMA_SUFFIX}`)}; expected the catalogue to define it`;
      return rejected(recordType, { instance_path: '', keyword: 'schema', detail });
    }
    // Ajv sets `errors` to null after a pass and to the error list after a failure.
    const passed = check(value);
    const errors = check.errors ?? [];
    if (passed) {
      return { valid: true, record: value as unknown as StudyRecord };
    }
    return { valid: false, record_type: recordType, violations: errors.map(toViolation) };
  };
  // Details quote untrusted values only through the bounded renderers, and Ajv's params hold
  // schema values and instance keys, never nested instance values (verbose is off), so validation
  // is total over deep or huge JSON and every violation has a bounded size (WP-00 review rounds 1-2).

  const validateAs = (type: RecordType, value: JsonValue): RecordValidation => {
    const declared = isJsonObject(value) ? value['record_type'] : undefined;
    if (declared !== undefined && declared !== type) {
      const detail = `record_type is ${boundedJsonText(declared)}; expected ${JSON.stringify(type)}`;
      return rejected(typeof declared === 'string' ? declared : undefined, {
        instance_path: '/record_type',
        keyword: 'const',
        detail,
      });
    }
    return validate(value);
  };

  return { validate, validateAs };
}

function createAjv(fileSystem: SchemaFileSystem, defsPath: string): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  registerRecordVocabulary(ajv);
  const defs = fileSystem.readFile(defsPath);
  if (defs === undefined) {
    throw new Error(`shared definitions ${defsPath} do not exist; expected _defs.schema.json`);
  }
  ajv.addSchema(readSchemaObject(defsPath, defs));
  return ajv;
}

function compileRecordSchema(
  ajv: Ajv2020,
  fileSystem: SchemaFileSystem,
  root: string,
  recordType: RecordType,
): ValidateFunction | undefined {
  const path = join(root, recordGroupOf(recordType), `${recordType}${SCHEMA_SUFFIX}`);
  const bytes = fileSystem.readFile(path);
  if (bytes === undefined) {
    return undefined;
  }
  const schema = readSchemaObject(path, bytes);
  const violations = findSchemaConventionViolations(recordType, schema);
  if (violations.length > 0) {
    throw new Error(`schema ${path} breaks the catalogue conventions: ${violations.join('; ')}`);
  }
  return ajv.compile(schema);
}

function readSchemaObject(path: string, bytes: Uint8Array): JsonObject {
  const parsed = parseJsonDocument(bytes);
  if (!parsed.ok) {
    throw new Error(
      `schema file ${path} is not a JSON document (${JSON.stringify(parsed.error)}); expected a JSON Schema object`,
    );
  }
  if (!isJsonObject(parsed.value)) {
    throw new Error(`schema file ${path} holds ${boundedJsonText(parsed.value)}; expected a JSON Schema object`);
  }
  return parsed.value;
}

function toViolation(error: ErrorObject): SchemaViolation {
  const params: JsonValue = error.params;
  return {
    instance_path: boundedText(error.instancePath, VIOLATION_TEXT_LIMIT),
    keyword: error.keyword,
    detail: [error.message, `(params ${boundedJsonText(params, VIOLATION_TEXT_LIMIT)})`].join(' '),
  };
}

function rejected(recordType: string | undefined, violation: SchemaViolation): RecordValidation {
  const base = { valid: false as const, violations: [violation] };
  return recordType === undefined ? base : { ...base, record_type: recordType };
}
