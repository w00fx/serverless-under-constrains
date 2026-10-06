// The clean canonical run the study-comparison unit tests start from: the committed fixture of the
// golden case `ac027-four-cell-completion` (all four trials frozen, a clean closure), finalized by
// the production code, plus byte-level edits that each test applies to reach one branch. Edits
// re-encode a JSON record canonically; a record other than the execution manifest keeps its
// correlation, because the manifest bytes, and so their digest, are unchanged.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { canonicalJson, serializeRecordFile } from '../../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import { isJsonObject } from '../../../../src/record-contract/json-value.ts';
import { parseJsonDocument, parseJsonl } from '../../../../src/record-contract/parsing.ts';
import type { JsonObject, Sha256Hex, Uuid4 } from '../../../../src/record-contract/primitives.ts';
import type { StudyRecord } from '../../../../src/record-contract/records/index.ts';
import type { UNIT_PATHS } from '../../../../src/evidence-package/package-layout.ts';
import { PACKAGE_LAYOUT } from '../../../../src/evidence-package/package-layout.ts';
import type { RunPackageRecords } from '../../../../src/study-comparison/run-package-reader.ts';
import type { FixtureBytes } from '../../../support/golden-builder/digest-links.ts';
import { loadGoldenCase } from '../../../golden/_harness/golden-harness.ts';
import { finalizeGoldenRun, readGoldenRun } from '../../../golden/study-comparison/support/golden-run.ts';

export { GOLDEN_DEPS as READ_DEPS } from '../../../golden/study-comparison/support/golden-run.ts';

const PROBE_MANIFEST = fileURLToPath(
  new URL('../../../golden/_harness/fixtures/base-probe/admission/execution-manifest.json', import.meta.url),
);
const CLEAN_CASE = 'test/golden/study-comparison/cases/ac027-four-cell-completion.case.ts';
const encoder = new TextEncoder();

let cleanFiles: Promise<FixtureBytes> | undefined;

/**
 * The clean run's files with its finalized comparison assessment and run summary.
 *
 * @example
 * const files = await cleanRunFiles();
 */
export function cleanRunFiles(): Promise<FixtureBytes> {
  cleanFiles ??= loadGoldenCase(CLEAN_CASE).then((loaded) => finalizeGoldenRun(loaded.files).files);
  return cleanFiles;
}

/**
 * The clean run's records as the reader returns them.
 *
 * @example
 * const records = await cleanRunRecords();
 */
export async function cleanRunRecords(): Promise<RunPackageRecords> {
  return readGoldenRun(await cleanRunFiles());
}

/**
 * A trial file's package path.
 *
 * @example
 * trialFile(records.trial_records[0].trial.trial_id, 'oracleResult');
 */
export function trialFile(trialId: Uuid4, file: keyof typeof UNIT_PATHS): string {
  return PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: trialId }, file);
}

/**
 * The files with one path replaced by the given bytes.
 *
 * @example
 * withBytes(files, 'cleanup/cleanup-result.json', new Uint8Array([0xff]));
 */
export function withBytes(files: FixtureBytes, path: string, bytes: Uint8Array): FixtureBytes {
  return new Map(files).set(path, bytes);
}

/**
 * The files with one path replaced by a typed record, canonically encoded.
 *
 * @example
 * withRecord(files, 'cleanup/cleanup-result.json', cleanup);
 */
export function withRecord(files: FixtureBytes, path: string, record: StudyRecord): FixtureBytes {
  return withBytes(files, path, serializeRecordFile(record));
}

/**
 * The files without one path.
 *
 * @example
 * withoutFile(files, 'cleanup/leak-audit-result.json');
 */
export function withoutFile(files: FixtureBytes, path: string): FixtureBytes {
  const copy = new Map(files);
  copy.delete(path);
  return copy;
}

/**
 * The files with one JSON object file edited; throws when the file is not a stored JSON object.
 *
 * @example
 * editJson(files, path, (record) => ({ ...record, cleanup_status: 'failed' }));
 */
export function editJson(files: FixtureBytes, path: string, edit: (record: JsonObject) => JsonObject): FixtureBytes {
  return withBytes(files, path, encoder.encode(`${canonicalJson(edit(storedObject(files, path)))}\n`));
}

/**
 * The files with one JSONL journal's lines edited; throws when a line is not a JSON object.
 *
 * @example
 * editJsonl(files, path, (lines) => [...lines, extraLine]);
 */
export function editJsonl(
  files: FixtureBytes,
  path: string,
  edit: (lines: readonly JsonObject[]) => readonly JsonObject[],
): FixtureBytes {
  const lines = parseJsonl(files.get(path) ?? new Uint8Array()).lines.map((line) => {
    if (!line.parsed.ok || !isJsonObject(line.parsed.value)) {
      throw new Error(`${path} line ${String(line.line_number)} is not a JSON object; expected a record line`);
    }
    return line.parsed.value;
  });
  return withBytes(
    files,
    path,
    encoder.encode(
      edit(lines)
        .map((line) => `${canonicalJson(line)}\n`)
        .join(''),
    ),
  );
}

/**
 * The stored JSON object at a path; throws when it is absent or not an object.
 *
 * @example
 * storedObject(files, 'admission/execution-manifest.json')['run_id'];
 */
export function storedObject(files: FixtureBytes, path: string): JsonObject {
  const parsed = parseJsonDocument(files.get(path) ?? new Uint8Array());
  if (!parsed.ok || !isJsonObject(parsed.value)) {
    throw new Error(`${path} is not a stored JSON object; expected a record file`);
  }
  return parsed.value;
}

/**
 * The digest of a stored file; throws when it is absent.
 *
 * @example
 * storedDigest(files, 'admission/execution-manifest.json');
 */
export function storedDigest(files: FixtureBytes, path: string): Sha256Hex {
  const bytes = files.get(path);
  if (bytes === undefined) {
    throw new Error(`${path} is absent; expected a stored file`);
  }
  return sha256Hex(bytes);
}

/**
 * The committed execution-manifest bytes of the harness's transport-probe base: a valid manifest
 * of another execution kind, which has no qualification.
 *
 * @example
 * withBytes(files, 'admission/execution-manifest.json', probeManifestBytes());
 */
export function probeManifestBytes(): Uint8Array {
  return readFileSync(PROBE_MANIFEST);
}
