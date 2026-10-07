// Reading evidence packages for the derived Study 1 results (close-out Phase 1). Every file comes
// from its package index, with bytes the caller already checked against the indexed digest. Every
// member read names the file, the member and the shape it expected, so a malformed package stops
// the derivation with its reason instead of leaving a silent gap in the results.

import { sha256Hex } from '../../src/record-contract/digests.ts';
import { describeJson, isJsonArray, isJsonObject } from '../../src/record-contract/json-value.ts';
import { parseJsonDocument, parseJsonl } from '../../src/record-contract/parsing.ts';
import type { JsonObject, JsonValue } from '../../src/record-contract/primitives.ts';

/** Reads the bytes of one file, by its path relative to the evidence root. */
export type EvidenceFileReader = (path: string) => Uint8Array;

/** One file of a package: its package-relative path, its indexed digest and its bytes. */
export interface PackageFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

/** One evidence package, located by its directory under the evidence root. */
export interface EvidencePackage {
  readonly directory: string;
  readonly index_sha256: string;
  readonly files: ReadonlyMap<string, PackageFile>;
}

/** A reference to one package artifact, in the shape the verification records use. */
export interface ArtifactRef {
  readonly package_index_sha256: string;
  readonly artifact_path: string;
  readonly artifact_sha256: string;
}

/** One parsed record and the reference that cites it. */
export interface CitedRecord {
  readonly record: JsonObject;
  readonly ref: ArtifactRef;
}

/** The parsed records of one JSONL file and the reference that cites them. */
export interface CitedLines {
  readonly records: readonly JsonObject[];
  readonly ref: ArtifactRef;
}

/**
 * The package under `directory`, every indexed file read and refused unless its bytes match the
 * indexed byte count and SHA-256. The package's identity is the digest of its index bytes.
 *
 * @example
 * const pkg = loadPackage('runs/abf41ffd-3008-4b29-81ee-b65d8095188b', (path) => readFileSync(join('evidence', path)));
 */
export function loadPackage(directory: string, read: EvidenceFileReader): EvidencePackage {
  const indexPath = `${directory}/package-index.json`;
  const indexBytes = read(indexPath);
  const index = parseRecord(indexBytes, indexPath);
  const files = new Map<string, PackageFile>();
  for (const entry of objectsOf(index, 'entries', indexPath)) {
    const file = indexedFile(entry, directory, read);
    files.set(file.path, file);
  }
  return { directory, index_sha256: sha256Hex(indexBytes), files };
}

/**
 * Whether the package indexes `path`.
 *
 * @example
 * holdsFile(pkg, 'trials/<id>/execution-metadata/durable-executions.json'); // false for a conventional trial
 */
export function holdsFile(pkg: EvidencePackage, path: string): boolean {
  return pkg.files.has(path);
}

/**
 * The record a package file holds, refused unless the file is exactly one JSON object.
 *
 * @example
 * const { record, ref } = readRecord(pkg, 'summary/run-summary.json');
 */
export function readRecord(pkg: EvidencePackage, path: string): CitedRecord {
  const file = packageFile(pkg, path);
  return { record: parseRecord(file.bytes, `${pkg.directory}/${path}`), ref: refOf(pkg, file) };
}

/**
 * The one JSON object `bytes` hold, refused otherwise; `subject` names the file in the error.
 *
 * @example
 * parseRecord(readFileSync('evidence/verifications/<id>/<at>-package-verification.json'), '<at>-package-verification.json');
 */
export function parseRecord(bytes: Uint8Array, subject: string): JsonObject {
  const parsed = parseJsonDocument(bytes);
  if (!parsed.ok || !isJsonObject(parsed.value)) {
    const found = parsed.ok ? describeJson(parsed.value) : JSON.stringify(parsed.error);
    throw new Error(`${subject} holds ${found}; expected one JSON object`);
  }
  return parsed.value;
}

/**
 * The records of a JSONL package file, refused unless every line is one JSON object.
 *
 * @example
 * const { records } = readLines(pkg, 'trials/<id>/journals/caller-journal.jsonl');
 */
export function readLines(pkg: EvidencePackage, path: string): CitedLines {
  const file = packageFile(pkg, path);
  const records = parseJsonl(file.bytes).lines.map((line) => {
    if (!line.parsed.ok || !isJsonObject(line.parsed.value)) {
      throw new Error(
        `${pkg.directory}/${path} line ${String(line.line_number)} is not one JSON object; expected a record`,
      );
    }
    return line.parsed.value;
  });
  return { records, ref: refOf(pkg, file) };
}

/**
 * A string member, refused when absent or of another type.
 *
 * @example
 * stringOf(summary, 'cleanup_status', 'runs/<id>/summary/run-summary.json'); // 'succeeded'
 */
export function stringOf(record: JsonObject, name: string, subject: string): string {
  const value = memberOf(record, name);
  if (typeof value !== 'string') {
    throw new Error(`${subject}: ${name} is ${describeJson(value)}; expected a string`);
  }
  return value;
}

/**
 * A safe-integer member, refused when absent or of another type.
 *
 * @example
 * integerOf(invocation, 'approximate_receive_count', 'caller journal'); // 2
 */
export function integerOf(record: JsonObject, name: string, subject: string): number {
  const value = memberOf(record, name);
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${subject}: ${name} is ${describeJson(value)}; expected a safe integer`);
  }
  return value;
}

/**
 * A boolean member, refused when absent or of another type.
 *
 * @example
 * booleanOf(oracle, 'correct_completion', 'oracle result'); // true
 */
export function booleanOf(record: JsonObject, name: string, subject: string): boolean {
  const value = memberOf(record, name);
  if (typeof value !== 'boolean') {
    throw new Error(`${subject}: ${name} is ${describeJson(value)}; expected a boolean`);
  }
  return value;
}

/**
 * An object member, refused when absent or of another type.
 *
 * @example
 * objectOf(manifest, 'qualification', 'execution manifest'); // { transport_probe_id: '…', … }
 */
export function objectOf(record: JsonObject, name: string, subject: string): JsonObject {
  const value = memberOf(record, name);
  if (!isJsonObject(value)) {
    throw new Error(`${subject}: ${name} is ${describeJson(value)}; expected an object`);
  }
  return value;
}

/**
 * An array-of-objects member, refused when absent, of another type, or holding a non-object.
 *
 * @example
 * objectsOf(ledger, 'transactions', 'ledger snapshot'); // [{ status: 'SUCCEEDED', … }]
 */
export function objectsOf(record: JsonObject, name: string, subject: string): readonly JsonObject[] {
  const value = memberOf(record, name);
  if (!isJsonArray(value) || !value.every(isJsonObject)) {
    throw new Error(`${subject}: ${name} is ${describeJson(value)}; expected an array of objects`);
  }
  return value;
}

/**
 * A member the record owns, or undefined: an inherited name such as `constructor` is never read
 * as a field of untrusted parsed data (Owner amendment A-05).
 *
 * @example
 * memberOf({ step_attempt: 2 }, 'step_attempt'); // 2
 */
export function memberOf(record: JsonObject, name: string): JsonValue | undefined {
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

/**
 * Orders artifact references by path, so a list of them serializes the same way every time.
 *
 * @example
 * [manifestRef, summaryRef].sort(byArtifactPath);
 */
export function byArtifactPath(a: ArtifactRef, b: ArtifactRef): number {
  if (a.artifact_path === b.artifact_path) {
    return 0;
  }
  return a.artifact_path < b.artifact_path ? -1 : 1;
}

function indexedFile(entry: JsonObject, directory: string, read: EvidenceFileReader): PackageFile {
  const subject = `${directory}/package-index.json entry`;
  const path = stringOf(entry, 'artifact_path', subject);
  const sha256 = stringOf(entry, 'sha256', subject);
  const byteCount = integerOf(entry, 'bytes', subject);
  const bytes = read(`${directory}/${path}`);
  const found = sha256Hex(bytes);
  if (found !== sha256 || bytes.length !== byteCount) {
    throw new Error(
      `${directory}/${path} is ${String(bytes.length)} bytes with SHA-256 ${found}; ` +
        `expected the indexed ${String(byteCount)} bytes with SHA-256 ${sha256}`,
    );
  }
  return { path, sha256, bytes };
}

function packageFile(pkg: EvidencePackage, path: string): PackageFile {
  const file = pkg.files.get(path);
  if (file === undefined) {
    throw new Error(`${pkg.directory} indexes no ${JSON.stringify(path)}; expected the package to hold it`);
  }
  return file;
}

function refOf(pkg: EvidencePackage, file: PackageFile): ArtifactRef {
  return { package_index_sha256: pkg.index_sha256, artifact_path: file.path, artifact_sha256: file.sha256 };
}
