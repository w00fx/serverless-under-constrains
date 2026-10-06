// The frozen evidence of a transport probe, rebuilt from the package as phase P5 ingested it
// (design §10.2 P5, §8.13; BR-RUA-043, BR-RUA-044): every package file that existed when the probe
// result was derived, as the golden probe input does (no execution scope). Left out are the files
// P5 and T11 wrote after that ingestion (the probe's `derived/` results, its evidence index, the
// coordination prefix checkpoint), the areas written after the freeze, and `package-index.json`.
// Two journals kept growing: the runner journal is cut before the probe's own freeze events (the
// P5 phase transition and `trial_evidence_frozen`), and the coordination journal is cut at the
// prefix the checkpoint froze. The expected artifacts are the probe workload request's, planned
// from the frozen manifests exactly as the runner planned it. Pure: it only reads the given files.

import type { IngestionInput, RawArtifact } from '../evidence-ingestion/ingestion-model.ts';
import { expectedArtifactsFor } from '../evidence-package/expected-artifacts.ts';
import type { PackageFile } from '../evidence-package/package-file-system.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import { isJsonObject } from '../record-contract/json-value.ts';
import { parseJsonDocument, parseJsonl } from '../record-contract/parsing.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { JsonValue, Result, StructuredReason } from '../record-contract/primitives.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import type { ResourceManifest } from '../record-contract/records/group-a/resource_manifest.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { readRecordFile } from '../study-comparison/record-files.ts';
import { planProbeWorkload } from '../trial-execution/probe-workload-plan.ts';
import type { AdmittedExecution } from './execution-ports.ts';
import { filesByPath } from './execution-package.ts';
import { executionTargetsOf } from './execution-targets.ts';
import { frozenInputReason, writtenAfterFreeze } from './frozen-trial-input.ts';

/** The probe's frozen evidence and the exact bytes of its frozen transport probe result. */
export interface FrozenProbeEvidence {
  readonly frozen: IngestionInput;
  /** `probe/derived/transport-probe-result.json` and its stored bytes. */
  readonly result: RawArtifact;
}

const PROBE = { kind: 'probe' } as const;
const PROBE_RESULT_PATH = PACKAGE_LAYOUT.unitFile(PROBE, 'transportProbeResult');

// Written by P5 and T11 after the probe evidence was ingested: the probe's derived results, and
// these files.
const PROBE_DERIVED = `${PACKAGE_LAYOUT.unitDirectory(PROBE)}/derived/`;
const WRITTEN_AT_FREEZE: ReadonlySet<string> = new Set([
  PACKAGE_LAYOUT.unitFile(PROBE, 'evidenceIndex'),
  EXECUTION_PATHS.coordinationPrefixCheckpoint,
  EXECUTION_PATHS.packageIndex,
]);

const NEWLINE = 0x0a;

/**
 * The probe's frozen evidence, `undefined` when no probe result was frozen, or why it cannot be
 * rebuilt (no readable resource manifest to plan from, or no readable prefix checkpoint).
 *
 * @example
 * const probe = frozenProbeEvidence(files, admitted, validator);
 * if (probe.ok && probe.value !== undefined) ingestEvidence(probe.value.frozen, validator);
 */
export function frozenProbeEvidence(
  files: readonly PackageFile[],
  admitted: AdmittedExecution,
  validator: RecordValidator,
): Result<FrozenProbeEvidence | undefined, StructuredReason> {
  const byPath = filesByPath(files);
  const result = byPath.get(PROBE_RESULT_PATH);
  if (result === undefined) {
    return ok(undefined);
  }
  const expected = expectedProbeArtifacts(byPath, admitted, validator);
  const prefix = checkpointedPrefix(byPath);
  if (!expected.ok) {
    return expected;
  }
  if (!prefix.ok) {
    return prefix;
  }
  const artifacts = files
    .filter((file) => !writtenAfterFreeze(file.path) && !writtenAtFreeze(file.path))
    .map((file) => frozenArtifact(file, prefix.value));
  return ok({
    frozen: { artifacts, expected: expected.value, execution_scope_artifacts: [] },
    result: { path: PROBE_RESULT_PATH, bytes: result },
  });
}

function writtenAtFreeze(path: string): boolean {
  return path.startsWith(PROBE_DERIVED) || WRITTEN_AT_FREEZE.has(path);
}

function frozenArtifact(file: PackageFile, coordinationPrefix: number): RawArtifact {
  if (file.path === EXECUTION_PATHS.coordinationJournal) {
    return { path: file.path, bytes: file.bytes.subarray(0, coordinationPrefix) };
  }
  if (file.path === EXECUTION_PATHS.runnerJournal) {
    return { path: file.path, bytes: runnerJournalBeforeFreeze(file.bytes) };
  }
  return file;
}

// The expected artifacts of the probe's workload request, planned from the frozen manifests.
function expectedProbeArtifacts(
  files: ReadonlyMap<string, Uint8Array>,
  admitted: AdmittedExecution,
  validator: RecordValidator,
): Result<IngestionInput['expected'], StructuredReason> {
  const manifest = resourceManifestOf(files, validator);
  const targets = manifest === undefined ? undefined : executionTargetsOf(manifest);
  const plan =
    targets?.ok === true
      ? planProbeWorkload(admitted.manifest, admitted.manifest_sha256, {
          provider_version: targets.value.provider_version,
          probe_caller_version: targets.value.probe_caller?.version ?? '',
        })
      : undefined;
  if (plan?.ok !== true) {
    const why = plan === undefined ? 'the resource manifest names no probe targets' : plan.error.detail;
    return err(
      frozenInputReason(
        'FROZEN_PROBE_INPUT_UNREADABLE',
        `${why}; expected the probe workload plan the frozen result was derived from`,
      ),
    );
  }
  return ok(expectedArtifactsFor(plan.value.request));
}

// The byte count of the coordination journal the checkpoint froze.
function checkpointedPrefix(files: ReadonlyMap<string, Uint8Array>): Result<number, StructuredReason> {
  const bytes = files.get(EXECUTION_PATHS.coordinationPrefixCheckpoint);
  const parsed = bytes === undefined ? undefined : parseJsonDocument(bytes);
  const count = parsed?.ok === true ? ownMember(parsed.value, 'prefix_byte_count') : undefined;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    return err(
      frozenInputReason(
        'FROZEN_PROBE_INPUT_UNREADABLE',
        `${EXECUTION_PATHS.coordinationPrefixCheckpoint} has no readable prefix_byte_count; expected the checkpoint P5 froze`,
      ),
    );
  }
  return ok(count);
}

// The runner journal up to the first line of the probe's own freeze: its P5 phase transition or
// its `trial_evidence_frozen`, both written after the probe evidence was ingested.
function runnerJournalBeforeFreeze(bytes: Uint8Array): Uint8Array {
  const report = parseJsonl(bytes);
  let offset = 0;
  for (const line of report.lines) {
    if (line.parsed.ok && isFreezeEvent(line.parsed.value)) {
      return bytes.subarray(0, offset);
    }
    const end = bytes.indexOf(NEWLINE, offset);
    offset = end < 0 ? bytes.length : end + 1;
  }
  return bytes;
}

function isFreezeEvent(event: JsonValue): boolean {
  const type = ownMember(event, 'record_type');
  return (
    type === 'trial_evidence_frozen' ||
    (type === 'phase_transition_recorded' && ownMember(event, 'phase') === 'PROBE_FREEZE')
  );
}

function ownMember(value: JsonValue, name: string): JsonValue | undefined {
  return isJsonObject(value) && Object.hasOwn(value, name) ? value[name] : undefined;
}

function resourceManifestOf(
  files: ReadonlyMap<string, Uint8Array>,
  validator: RecordValidator,
): ResourceManifest | undefined {
  const read = readRecordFile(files, EXECUTION_PATHS.resourceManifest, 'resource_manifest', {
    validator,
    digest: sha256Hex,
  });
  return read.status === 'read' ? read.frozen.record : undefined;
}
