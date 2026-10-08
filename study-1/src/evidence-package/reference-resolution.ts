// Reference resolution (design §8.16 step 4; BR-RUA-035): every reference a derived record of the
// package makes must resolve, or the package is ineligible with `UNRESOLVED_REFERENCE`.
// - The references are the members of every `evidence_refs` and `oracle_result_refs` array and
//   every `*_ref` member, at any depth of the record (summaries and results carry `ArtifactRef`
//   members such as `oracle_result_ref`, conditions carry `evidence_refs`, the comparison carries
//   `oracle_result_refs`). These are every reference member of the group-C catalogue;
//   `clock_assumption_refs` holds clock-assumption ids, not artifact references, so it is not one.
// - A same-package reference names an indexed path whose indexed digest equals `artifact_sha256`.
//   The runner journal alone may also be cited by the digest of a line-boundary prefix of its
//   indexed bytes (Owner amendment A-15, decision 80; BR-RUA-044 prefix model): it stays open
//   through P6-P9, after the trial and probe freezes whose results cite it. The `event_id` and
//   `json_pointer` of such a reference resolve inside that prefix only.
//   An `event_id` names the JSONL line (or the JSON document) whose own `event_id` is that id. A
//   `json_pointer` resolves inside that event, or inside the document; a JSONL file without an
//   event id is addressed as the array of its lines (evidence/WP-13/decisions.md).
// - A reference with `package_index_sha256` crosses into another package; it resolves when that
//   digest is one the caller knows (for example the selected probe package of a run).
// The walk over a record is iterative and reads own members only (A-05).

import { boundedJsonText, isJsonArray, isJsonObject } from '../record-contract/json-value.ts';
import { parseJsonDocument, parseJsonl } from '../record-contract/parsing.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { JsonObject, JsonValue, Result, Sha256Hex } from '../record-contract/primitives.ts';
import type { PackageIneligibilityReason } from '../record-contract/records/group-c/package_verification.ts';
import type { IndexEntry } from '../record-contract/records/group-c/shared-shapes.ts';
import { fileAt } from './index-entries.ts';
import { resolveJsonPointer } from './json-pointer.ts';
import { LinePrefixDigests } from './line-prefix-digests.ts';
import { ineligibility } from './package-integrity.ts';
import type { ByteDigest } from './package-integrity.ts';
import type { PackageFile } from './package-file-system.ts';
import { EXECUTION_PATHS } from './package-layout.ts';

export interface ReferenceScope {
  /** The entries of the package index, the only same-package targets. */
  readonly entries: readonly IndexEntry[];
  readonly files: readonly PackageFile[];
  /** Package-index digests a cross-package reference may name. */
  readonly referenced_package_indexes: readonly Sha256Hex[];
}

type ParsedArtifact =
  | { readonly kind: 'json'; readonly value: JsonValue }
  | { readonly kind: 'jsonl'; readonly lines: readonly (JsonValue | undefined)[] };

/** What one verification reads at most once: parsed files and the runner journal's prefixes. */
interface ResolutionCache {
  readonly digest: ByteDigest;
  /** Whole stored files, parsed, by path. */
  readonly parsed: Map<string, Result<ParsedArtifact, string>>;
  /** Line-boundary prefix digests, by path (only the runner journal is ever looked up). */
  readonly prefixes: Map<string, LinePrefixDigests>;
  /** Runner-journal prefixes, parsed, by byte length. */
  readonly parsedPrefixes: Map<number, ParsedArtifact>;
}

/** Where a same-package reference points: the whole indexed file, or a line-boundary prefix of it. */
type ReferencedBytes = { readonly kind: 'whole' } | { readonly kind: 'prefix'; readonly bytes: Uint8Array };

const REFERENCE_LISTS: ReadonlySet<string> = new Set(['evidence_refs', 'oracle_result_refs']);
const REF_SUFFIX = '_ref';
const JSONL_SUFFIX = '.jsonl';
const JSON_SUFFIX = '.json';
const NO_BYTES = new Uint8Array();

/**
 * Every `UNRESOLVED_REFERENCE` reason of the derived JSON records the package index lists.
 * `digest` hashes runner-journal prefixes (production: `sha256Hex`).
 *
 * @example
 * unresolvedReferenceReasons({ entries: index.entries, files, referenced_package_indexes: [] }, sha256Hex); // [] when all resolve
 */
export function unresolvedReferenceReasons(
  scope: ReferenceScope,
  digest: ByteDigest,
): readonly PackageIneligibilityReason[] {
  const cache: ResolutionCache = { digest, parsed: new Map(), prefixes: new Map(), parsedPrefixes: new Map() };
  const records = scope.entries.filter(
    (entry) => entry.derivation === 'derived' && entry.artifact_path.endsWith(JSON_SUFFIX),
  );
  return records.flatMap((entry) => recordReasons(entry.artifact_path, scope, cache));
}

function recordReasons(
  path: string,
  scope: ReferenceScope,
  cache: ResolutionCache,
): readonly PackageIneligibilityReason[] {
  const file = fileAt(scope.files, path);
  const record = file === undefined ? undefined : parseJsonDocument(file.bytes);
  if (!record?.ok) {
    return [unresolved(path, 'its references cannot be read; expected one stored UTF-8 JSON record')];
  }
  return collectReferences(record.value).flatMap((reference) => {
    const problem = referenceProblem(reference, scope, cache);
    return problem === undefined ? [] : [unresolved(path, `reference ${boundedJsonText(reference)} ${problem}`)];
  });
}

/**
 * Every reference object a record makes, found by an iterative walk over own members.
 *
 * @example
 * collectReferences({ evidence_refs: [ref], cleanup_result_ref: other }); // [ref, other]
 */
export function collectReferences(record: JsonValue): readonly JsonValue[] {
  const found: JsonValue[] = [];
  const pending: JsonValue[] = [record];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    // Pushed one by one: spreading a very large array into push() overflows the call stack (A-05).
    const children: readonly JsonValue[] = isJsonArray(next) ? next : isJsonObject(next) ? Object.values(next) : [];
    for (const child of children) {
      pending.push(child);
    }
    for (const reference of isJsonObject(next) ? referencesHeldBy(next) : []) {
      found.push(reference);
    }
  }
  return found;
}

function referencesHeldBy(object: JsonObject): readonly JsonValue[] {
  return Object.keys(object).flatMap((key) => {
    const member = object[key] as JsonValue;
    if (REFERENCE_LISTS.has(key)) {
      return isJsonArray(member) ? member : [member];
    }
    return key.endsWith(REF_SUFFIX) ? [member] : [];
  });
}

function referenceProblem(reference: JsonValue, scope: ReferenceScope, cache: ResolutionCache): string | undefined {
  const path = stringMember(reference, 'artifact_path');
  const digest = stringMember(reference, 'artifact_sha256');
  if (path === undefined || digest === undefined) {
    return 'has no string artifact_path and artifact_sha256; expected an evidence reference';
  }
  const packageIndex = memberOf(reference, 'package_index_sha256');
  if (packageIndex !== undefined) {
    return scope.referenced_package_indexes.some((known) => known === packageIndex)
      ? undefined
      : 'names an unknown package_index_sha256; expected a package index known to the verification';
  }
  const entry = scope.entries.find((candidate) => candidate.artifact_path === path);
  if (entry === undefined) {
    return 'names a path the package index does not list';
  }
  const bytes = referencedBytes(entry, digest, scope.files, cache);
  if (bytes === undefined) {
    return `names sha256 ${digest}; the indexed file has ${entry.sha256}${prefixExpectation(entry)}`;
  }
  return locationProblem(reference, () => artifactAt(path, bytes, scope.files, cache));
}

// The runner journal also accepts a prefix digest, so its mismatch says so (expected shape).
function prefixExpectation(entry: IndexEntry): string {
  return entry.artifact_path === EXECUTION_PATHS.runnerJournal
    ? '; expected that digest or the digest of a line-boundary prefix of the indexed journal (A-15)'
    : '';
}

// A-15 / BR-RUA-044: the runner journal is still appended after the freezes whose records cite it,
// so a line-boundary prefix of its indexed bytes is a valid target. Every other path must match its
// indexed digest exactly; the coordination journal keeps its prefix checkpoint instead.
function referencedBytes(
  entry: IndexEntry,
  digest: string,
  files: readonly PackageFile[],
  cache: ResolutionCache,
): ReferencedBytes | undefined {
  if (entry.sha256 === digest) {
    return { kind: 'whole' };
  }
  if (entry.artifact_path !== EXECUTION_PATHS.runnerJournal) {
    return undefined;
  }
  const prefix = indexedPrefixes(entry, files, cache).prefixWithDigest(digest);
  return prefix === undefined ? undefined : { kind: 'prefix', bytes: prefix };
}

// The prefixes of the stored journal, when the stored bytes are the indexed bytes; none otherwise
// (altered bytes are ALTERED_BYTES, and a prefix of them is not a prefix of the indexed file).
function indexedPrefixes(entry: IndexEntry, files: readonly PackageFile[], cache: ResolutionCache): LinePrefixDigests {
  const cached = cache.prefixes.get(entry.artifact_path);
  if (cached !== undefined) {
    return cached;
  }
  const stored = fileAt(files, entry.artifact_path)?.bytes ?? NO_BYTES;
  const indexed = cache.digest(stored) === entry.sha256 ? stored : NO_BYTES;
  const prefixes = new LinePrefixDigests(indexed, cache.digest);
  cache.prefixes.set(entry.artifact_path, prefixes);
  return prefixes;
}

function locationProblem(reference: JsonValue, readArtifact: () => Result<ParsedArtifact, string>): string | undefined {
  const eventId = memberOf(reference, 'event_id');
  const pointer = memberOf(reference, 'json_pointer');
  if (eventId === undefined && pointer === undefined) {
    return undefined;
  }
  const artifact = readArtifact();
  if (!artifact.ok) {
    return `points into a file that cannot be read: ${artifact.error}`;
  }
  const target = eventId === undefined ? wholeDocument(artifact.value) : eventIn(artifact.value, eventId);
  if (target === undefined) {
    return eventId === undefined
      ? 'points into a JSONL file with an unparseable line'
      : 'names an event_id the file does not hold';
  }
  if (pointer === undefined) {
    return undefined;
  }
  return typeof pointer === 'string' && resolveJsonPointer(target.value, pointer).found
    ? undefined
    : 'has a json_pointer that resolves to nothing; expected an RFC 6901 pointer to an existing value';
}

function wholeDocument(artifact: ParsedArtifact): { readonly value: JsonValue } | undefined {
  if (artifact.kind === 'json') {
    return { value: artifact.value };
  }
  const lines = artifact.lines.filter((line) => line !== undefined);
  return lines.length === artifact.lines.length ? { value: lines } : undefined;
}

function eventIn(artifact: ParsedArtifact, eventId: JsonValue): { readonly value: JsonValue } | undefined {
  const candidates = artifact.kind === 'json' ? [artifact.value] : artifact.lines;
  const event = candidates.find((candidate) => candidate !== undefined && memberOf(candidate, 'event_id') === eventId);
  return event === undefined ? undefined : { value: event };
}

function artifactAt(
  path: string,
  bytes: ReferencedBytes,
  files: readonly PackageFile[],
  cache: ResolutionCache,
): Result<ParsedArtifact, string> {
  return bytes.kind === 'whole' ? parsedArtifact(path, files, cache) : ok(parsedPrefix(bytes.bytes, cache));
}

function parsedArtifact(
  path: string,
  files: readonly PackageFile[],
  cache: ResolutionCache,
): Result<ParsedArtifact, string> {
  const cached = cache.parsed.get(path);
  if (cached !== undefined) {
    return cached;
  }
  const parsed = parseStored(path, fileAt(files, path));
  cache.parsed.set(path, parsed);
  return parsed;
}

// Only the lines of the prefix are parsed, so an event appended after the freeze cannot satisfy
// a reference to the frozen prefix. Every prefix is one of the runner journal's, so its length
// identifies it.
function parsedPrefix(prefix: Uint8Array, cache: ResolutionCache): ParsedArtifact {
  const cached = cache.parsedPrefixes.get(prefix.length);
  if (cached !== undefined) {
    return cached;
  }
  const parsed = parsedJsonl(prefix);
  cache.parsedPrefixes.set(prefix.length, parsed);
  return parsed;
}

function parseStored(path: string, file: PackageFile | undefined): Result<ParsedArtifact, string> {
  if (file === undefined) {
    return err(`${boundedJsonText(path)} is absent`);
  }
  if (path.endsWith(JSONL_SUFFIX)) {
    return ok(parsedJsonl(file.bytes));
  }
  const parsed = parseJsonDocument(file.bytes);
  return parsed.ok
    ? ok({ kind: 'json', value: parsed.value })
    : err(`${boundedJsonText(path)} is not one UTF-8 JSON document`);
}

function parsedJsonl(bytes: Uint8Array): ParsedArtifact {
  const report = parseJsonl(bytes);
  return { kind: 'jsonl', lines: report.lines.map((line) => (line.parsed.ok ? line.parsed.value : undefined)) };
}

function memberOf(value: JsonValue, key: string): JsonValue | undefined {
  return isJsonObject(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

function stringMember(value: JsonValue, key: string): string | undefined {
  const member = memberOf(value, key);
  return typeof member === 'string' ? member : undefined;
}

function unresolved(path: string, detail: string): PackageIneligibilityReason {
  return ineligibility('UNRESOLVED_REFERENCE', `${boundedJsonText(path)}: ${detail}`, '', path);
}
