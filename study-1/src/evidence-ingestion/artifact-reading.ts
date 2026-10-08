// Design §8.2 step I1: every artifact is read as strict UTF-8 JSON (one document) or JSONL (one
// record per line) through the kernel's total parsers, and every required artifact must be present.
// An artifact whose bytes do not parse is reported (ARTIFACT_UNPARSEABLE, evidence integrity
// invalid when it is required evidence); the lines that do parse are still kept, so one torn line
// never hides the rest of a journal. A required artifact that is absent is ARTIFACT_MISSING: the
// gates that need it become unverified.

import { sha256Hex } from '../record-contract/digests.ts';
import { classifyArtifactPath } from '../record-contract/evidence-refs.ts';
import { boundedJsonText } from '../record-contract/json-value.ts';
import { parseJsonDocument, parseJsonl } from '../record-contract/parsing.ts';
import type { JsonParseFailure } from '../record-contract/parsing.ts';
import type { JsonValue, Result } from '../record-contract/primitives.ts';
import { aggregatedDetail, ingestionFinding } from './ingestion-findings.ts';
import type {
  ArtifactOrigin,
  ExpectedArtifact,
  IngestedArtifact,
  IngestionFinding,
  IngestionInput,
  RawArtifact,
} from './ingestion-model.ts';

/** One parsed document or JSONL line, before schema validation. */
export interface ParsedValue {
  readonly line_number?: number;
  readonly value: JsonValue;
}

/** An artifact after step I1: its digest, origin, expected class and parsed values. */
export type ParsedArtifact = Omit<IngestedArtifact, 'records'> & { readonly values: readonly ParsedValue[] };

export interface ArtifactReading {
  readonly artifacts: readonly ParsedArtifact[];
  readonly findings: readonly IngestionFinding[];
}

const JSONL_SUFFIX = '.jsonl';

/**
 * Reads every artifact of an ingestion input (subject, supplementary and execution-scope) and
 * reports unparseable, repeated, badly named and missing required artifacts. Total: it returns a
 * reading for any bytes.
 *
 * @example
 * const reading = readArtifacts(input);
 * reading.findings.filter((finding) => finding.code === 'ARTIFACT_MISSING');
 */
export function readArtifacts(input: IngestionInput): ArtifactReading {
  const expectedByPath = new Map(input.expected.map((expected) => [expected.path, expected]));
  const sources: readonly { readonly raw: RawArtifact; readonly scope: boolean }[] = [
    ...input.artifacts.map((raw) => ({ raw, scope: false })),
    ...input.execution_scope_artifacts.map((raw) => ({ raw, scope: true })),
  ];
  const artifacts = new Map<string, ParsedArtifact>();
  const findings: IngestionFinding[] = [];
  for (const { raw, scope } of sources) {
    const origin: ArtifactOrigin = scope ? 'execution_scope' : originOf(raw.path, expectedByPath);
    const accepted = acceptPath(raw, artifacts);
    if (!accepted.ok) {
      findings.push(...accepted.error);
      continue;
    }
    const parsed = parseArtifact(raw, origin, expectedByPath.get(raw.path));
    artifacts.set(raw.path, parsed.artifact);
    findings.push(...parsed.findings);
  }
  return { artifacts: [...artifacts.values()], findings: [...findings, ...missingRequired(input.expected, artifacts)] };
}

function originOf(path: string, expectedByPath: ReadonlyMap<string, ExpectedArtifact>): ArtifactOrigin {
  return expectedByPath.has(path) ? 'subject' : 'supplementary';
}

// A path must be normalized (BR-RUA-035) and name one byte sequence. A repeat with identical bytes
// is the same artifact given twice and is collapsed; a repeat with other bytes is ambiguous.
function acceptPath(
  raw: RawArtifact,
  seen: ReadonlyMap<string, ParsedArtifact>,
): Result<true, readonly IngestionFinding[]> {
  const violation = raw.path === '' ? 'EMPTY_PATH' : classifyArtifactPath(raw.path);
  if (violation !== undefined) {
    const detail = `artifact path ${boundedJsonText(raw.path)} is ${violation}; expected a normalized package-relative POSIX path`;
    return { ok: false, error: [ingestionFinding('ARTIFACT_UNPARSEABLE', detail)] };
  }
  const earlier = seen.get(raw.path);
  if (earlier === undefined) {
    return { ok: true, value: true };
  }
  if (earlier.sha256 === sha256Hex(raw.bytes)) {
    return { ok: false, error: [] };
  }
  const detail = `${raw.path} is given twice with different bytes; expected one byte sequence per path (the first is kept)`;
  return { ok: false, error: [ingestionFinding('ARTIFACT_UNPARSEABLE', detail, { artifact_path: raw.path })] };
}

function parseArtifact(
  raw: RawArtifact,
  origin: ArtifactOrigin,
  expected: ExpectedArtifact | undefined,
): { readonly artifact: ParsedArtifact; readonly findings: readonly IngestionFinding[] } {
  const lines = raw.path.endsWith(JSONL_SUFFIX) ? jsonlValues(raw.bytes) : [documentValue(raw.bytes)];
  const values = lines.flatMap((line) => (line.parsed.ok ? [{ ...line.position, value: line.parsed.value }] : []));
  const failures = lines.flatMap((line) => (line.parsed.ok ? [] : [describeFailure(line.position, line.parsed.error)]));
  const artifact: ParsedArtifact = {
    path: raw.path,
    sha256: sha256Hex(raw.bytes),
    byte_length: raw.bytes.length,
    origin,
    ...(expected === undefined ? {} : { artifact_class: expected.artifact_class, requirement: expected.requirement }),
    parse_status: failures.length === 0 ? 'parsed' : 'unparseable',
    values,
  };
  const [first] = failures;
  if (first === undefined) {
    return { artifact, findings: [] };
  }
  const detail = aggregatedDetail(`expected strict UTF-8 JSON; ${first}`, failures.length);
  return {
    artifact,
    findings: [
      ingestionFinding('ARTIFACT_UNPARSEABLE', detail, { artifact_path: raw.path, occurrences: failures.length }),
    ],
  };
}

interface PositionedParse {
  readonly position: { readonly line_number?: number };
  readonly parsed: Result<JsonValue, JsonParseFailure>;
}

function jsonlValues(bytes: Uint8Array): readonly PositionedParse[] {
  return parseJsonl(bytes).lines.map((line) => ({ position: { line_number: line.line_number }, parsed: line.parsed }));
}

function documentValue(bytes: Uint8Array): PositionedParse {
  return { position: {}, parsed: parseJsonDocument(bytes) };
}

function describeFailure(position: { readonly line_number?: number }, failure: JsonParseFailure): string {
  const where = position.line_number === undefined ? 'document' : `line ${String(position.line_number)}`;
  const what =
    failure.kind === 'invalid_utf8' ? `invalid UTF-8 at byte ${String(failure.byte_offset)}` : failure.detail;
  return `${where}: ${what}`;
}

function missingRequired(
  expected: readonly ExpectedArtifact[],
  artifacts: ReadonlyMap<string, ParsedArtifact>,
): readonly IngestionFinding[] {
  return expected
    .filter((artifact) => artifact.requirement === 'required' && !artifacts.has(artifact.path))
    .map((artifact) => missingArtifactFinding(artifact));
}

/**
 * The finding for an expected artifact that is absent; shared with the conditional DLQ snapshot
 * check, which decides only later that its artifact was required.
 *
 * @example
 * missingArtifactFinding({ path: 'trials/t/ledger/ledger-snapshot.json', artifact_class: 'ledger_snapshot', requirement: 'required' });
 */
export function missingArtifactFinding(artifact: ExpectedArtifact): IngestionFinding {
  const detail = `${artifact.path} (${artifact.artifact_class}) is absent; expected the ${artifact.requirement} artifact to be present`;
  return ingestionFinding('ARTIFACT_MISSING', detail, { artifact_path: artifact.path });
}
