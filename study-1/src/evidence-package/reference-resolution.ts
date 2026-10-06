// Reference resolution (design §8.16 step 4; BR-RUA-035): every reference a derived record of the
// package makes must resolve, or the package is ineligible with `UNRESOLVED_REFERENCE`.
// - The references are the members of every `evidence_refs` and `oracle_result_refs` array and
//   every `*_ref` member, at any depth of the record (summaries and results carry `ArtifactRef`
//   members such as `oracle_result_ref`, conditions carry `evidence_refs`, the comparison carries
//   `oracle_result_refs`). These are every reference member of the group-C catalogue;
//   `clock_assumption_refs` holds clock-assumption ids, not artifact references, so it is not one.
// - A same-package reference names an indexed path whose indexed digest equals `artifact_sha256`.
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
import { ineligibility } from './package-integrity.ts';
import type { PackageFile } from './package-file-system.ts';

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

const REFERENCE_LISTS: ReadonlySet<string> = new Set(['evidence_refs', 'oracle_result_refs']);
const REF_SUFFIX = '_ref';
const JSONL_SUFFIX = '.jsonl';
const JSON_SUFFIX = '.json';

/**
 * Every `UNRESOLVED_REFERENCE` reason of the derived JSON records the package index lists.
 *
 * @example
 * unresolvedReferenceReasons({ entries: index.entries, files, referenced_package_indexes: [] }); // [] when all resolve
 */
export function unresolvedReferenceReasons(scope: ReferenceScope): readonly PackageIneligibilityReason[] {
  const cache = new Map<string, Result<ParsedArtifact, string>>();
  const records = scope.entries.filter(
    (entry) => entry.derivation === 'derived' && entry.artifact_path.endsWith(JSON_SUFFIX),
  );
  return records.flatMap((entry) => recordReasons(entry.artifact_path, scope, cache));
}

function recordReasons(
  path: string,
  scope: ReferenceScope,
  cache: Map<string, Result<ParsedArtifact, string>>,
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

function referenceProblem(
  reference: JsonValue,
  scope: ReferenceScope,
  cache: Map<string, Result<ParsedArtifact, string>>,
): string | undefined {
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
  if (entry?.sha256 !== digest) {
    return entry === undefined
      ? 'names a path the package index does not list'
      : `names sha256 ${digest}; the indexed file has ${entry.sha256}`;
  }
  return locationProblem(reference, path, scope.files, cache);
}

function locationProblem(
  reference: JsonValue,
  path: string,
  files: readonly PackageFile[],
  cache: Map<string, Result<ParsedArtifact, string>>,
): string | undefined {
  const eventId = memberOf(reference, 'event_id');
  const pointer = memberOf(reference, 'json_pointer');
  if (eventId === undefined && pointer === undefined) {
    return undefined;
  }
  const artifact = parsedArtifact(path, files, cache);
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

function parsedArtifact(
  path: string,
  files: readonly PackageFile[],
  cache: Map<string, Result<ParsedArtifact, string>>,
): Result<ParsedArtifact, string> {
  const cached = cache.get(path);
  if (cached !== undefined) {
    return cached;
  }
  const parsed = parseStored(path, fileAt(files, path));
  cache.set(path, parsed);
  return parsed;
}

function parseStored(path: string, file: PackageFile | undefined): Result<ParsedArtifact, string> {
  if (file === undefined) {
    return err(`${boundedJsonText(path)} is absent`);
  }
  if (path.endsWith(JSONL_SUFFIX)) {
    const report = parseJsonl(file.bytes);
    return ok({ kind: 'jsonl', lines: report.lines.map((line) => (line.parsed.ok ? line.parsed.value : undefined)) });
  }
  const parsed = parseJsonDocument(file.bytes);
  return parsed.ok
    ? ok({ kind: 'json', value: parsed.value })
    : err(`${boundedJsonText(path)} is not one UTF-8 JSON document`);
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
