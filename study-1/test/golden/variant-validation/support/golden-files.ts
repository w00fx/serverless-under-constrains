// Small file builders shared by the golden package and amendment builders: canonical record files,
// placeholder files the references can pin, and references to stored bytes.

import { serializeRecordFile } from '../../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import type { JsonValue, Sha256Hex } from '../../../../src/record-contract/primitives.ts';
import type { StudyRecord } from '../../../../src/record-contract/records/index.ts';
import type { ArtifactRef } from '../../../../src/record-contract/records/group-c/shared-shapes.ts';
import type { PackageFile } from '../../../../src/evidence-package/package-file-system.ts';

export const encoder = new TextEncoder();

/**
 * The file at `path`; a golden builder that lost a file it stored is a fixture bug.
 *
 * @example
 * fileAtPath(files, 'admission/execution-manifest.json').bytes;
 */
export function fileAtPath(files: readonly PackageFile[], path: string): PackageFile {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new Error(`golden package lacks ${path}; expected the builder to have stored it`);
  }
  return file;
}

/**
 * A reference to the exact stored bytes of `file`.
 *
 * @example
 * refTo(summaryFile); // { artifact_path: 'summary/validation-summary.json', artifact_sha256: '…' }
 */
export function refTo(file: PackageFile): ArtifactRef {
  return { artifact_path: file.path, artifact_sha256: sha256Hex(file.bytes) };
}

/**
 * A one-line placeholder for a file the verifier never interprets; its bytes name its path.
 *
 * @example
 * placeholder('runner/runner-journal.jsonl');
 */
export function placeholder(path: string): PackageFile {
  return { path, bytes: encoder.encode(`${JSON.stringify({ golden_placeholder: path })}\n`) };
}

/**
 * A record file in the kernel's canonical serialization.
 *
 * @example
 * recordFile('summary/validation-summary.json', summary);
 */
export function recordFile(path: string, record: object): PackageFile {
  return { path, bytes: serializeRecordFile(record as StudyRecord) };
}

/**
 * A plain JSON file, for an example that is not a typed record.
 *
 * @example
 * jsonFile('provisioning/resource-manifest.json', manifest);
 */
export function jsonFile(path: string, value: object): PackageFile {
  return { path, bytes: encoder.encode(`${JSON.stringify(value)}\n`) };
}

/**
 * A typed record as the JSON value a reader would parse back.
 *
 * @example
 * validator.validateAs('validation_summary', toJsonValue(summary));
 */
export function toJsonValue(record: object): JsonValue {
  return JSON.parse(JSON.stringify(record)) as JsonValue;
}

/**
 * `files` with the file at `path` replaced by `bytes`, or added when absent.
 *
 * @example
 * replaceFile(files, 'summary/safety-assessment.json', utf8('{}'));
 */
export function replaceFile(files: readonly PackageFile[], path: string, bytes: Uint8Array): readonly PackageFile[] {
  return [...files.filter((file) => file.path !== path), { path, bytes }];
}

/**
 * `files` without the file at `path`.
 *
 * @example
 * withoutFile(files, 'admission/oracle-revision-check.json');
 */
export function withoutFile(files: readonly PackageFile[], path: string): readonly PackageFile[] {
  return files.filter((file) => file.path !== path);
}

/** Re-exported so callers that build digests over fixture bytes name one function. */
export type { Sha256Hex };
