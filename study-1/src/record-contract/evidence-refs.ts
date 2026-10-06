// Evidence references (BR-RUA-035, AC-RUA-048). A reference names an artifact by a
// normalized package-relative POSIX path and its digest. Lists are sorted canonically and
// duplicate-free; a conclusive result carries at least one reference; an indeterminate
// result may carry none only when every structured reason is a missing-evidence reason that
// names the missing artifact or event.

import { isSha256Hex } from './digests.ts';
import { isUuid4 } from './identifiers.ts';
import { boundedJsonText, describeJson, isJsonObject } from './json-value.ts';
import type { JsonValue, Sha256Hex, StructuredReason, Uuid4 } from './primitives.ts';

export interface EvidenceRef {
  readonly artifact_path: string;
  readonly artifact_sha256: Sha256Hex;
  readonly event_id?: Uuid4;
  readonly json_pointer?: string;
  readonly package_index_sha256?: Sha256Hex;
}

export type EvidenceRefViolation =
  | 'ABSOLUTE_PATH'
  | 'PARENT_TRAVERSAL'
  | 'NON_NORMALIZED_PATH'
  | 'UNSORTED'
  | 'DUPLICATE'
  | 'ALIAS_FIELD'
  | 'MISSING_REFERENCE_FOR_CONCLUSIVE_RESULT'
  | 'EMPTY_WITHOUT_MISSING_EVIDENCE_REASON'
  | 'CROSS_PACKAGE_WITHOUT_INDEX_DIGEST'
  | 'MALFORMED_FIELD';

export interface EvidenceRefFinding {
  readonly violation: EvidenceRefViolation;
  readonly detail: string;
}

/**
 * Where the container that holds the list lives. Inside a package, a reference without
 * `package_index_sha256` points into that same package. Outside every package (for example
 * `evidence/verifications/`), each reference crosses into a package and must pin its index.
 */
export type ReferenceLocation = 'inside_package' | 'outside_package';

/** Field names BR-RUA-035 rejects as aliases of `evidence_refs`. */
export const EVIDENCE_REF_ALIASES = ['evidence_references', 'evidence', 'references'] as const;

/**
 * Reason codes that mean "this evidence is absent", the only cause that lets an indeterminate
 * result carry no reference (BR-RUA-035). They are the approved design's absence codes: an
 * expected artifact that is not present (§8.2 I1 `ARTIFACT_MISSING`), a causal predecessor event
 * that does not resolve (§8.2 I6 `CAUSAL_PREDECESSOR_MISSING`), and an absent payment or decision
 * input (§8.5 `INPUT_MISSING`). Any other cause, such as a digest mismatch or a sequence gap,
 * concerns evidence that exists and can be referenced (WP-00 review round 2).
 */
export const MISSING_EVIDENCE_REASON_CODES = [
  'ARTIFACT_MISSING',
  'CAUSAL_PREDECESSOR_MISSING',
  'INPUT_MISSING',
] as const;

const REF_FIELDS: ReadonlySet<string> = new Set([
  'artifact_path',
  'artifact_sha256',
  'event_id',
  'json_pointer',
  'package_index_sha256',
]);
/** The members that order references, in comparison order (BR-RUA-035 canonical sort). */
const ORDER_KEYS = ['artifact_path', 'artifact_sha256', 'event_id', 'json_pointer', 'package_index_sha256'] as const;
const JSON_POINTER_PATTERN = /^(\/([^/~]|~[01])*)*$/;
// A drive root such as `C:/` or `C:\` is absolute on Windows. `c:relative` or `a:b.json` is a
// legal relative POSIX name, so only the rooted form is rejected (WP-00 review round 1).
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:[/\\]/;
// A NUL character or whitespace at either end is never part of a normalized package path: a NUL
// cuts the name short at the filesystem call, and edge whitespace gives one artifact two
// spellings (M0 chores, kernel defect). `\s` with the `u` flag is the ECMAScript WhiteSpace and
// LineTerminator set, the same set the catalogue's nonempty-trimmed pattern refuses at the edges.
const EDGE_WHITESPACE_PATTERN = /^\s|\s$/u;

/**
 * Classifies a path against BR-RUA-035; `undefined` means it is a normalized
 * package-relative POSIX path.
 *
 * @example
 * classifyArtifactPath('/tmp/x.json'); // 'ABSOLUTE_PATH'
 * classifyArtifactPath('trials/t/../x'); // 'PARENT_TRAVERSAL'
 * classifyArtifactPath(' trials/t/x.json'); // 'NON_NORMALIZED_PATH'
 * classifyArtifactPath('trials/t/ledger/ledger-snapshot.json'); // undefined
 */
export function classifyArtifactPath(path: string): EvidenceRefViolation | undefined {
  if (path.startsWith('/') || WINDOWS_DRIVE_PATTERN.test(path)) {
    return 'ABSOLUTE_PATH';
  }
  const segments = path.split('/');
  if (segments.includes('..')) {
    return 'PARENT_TRAVERSAL';
  }
  if (isNonNormalized(path, segments)) {
    return 'NON_NORMALIZED_PATH';
  }
  return undefined;
}

function isNonNormalized(path: string, segments: readonly string[]): boolean {
  return (
    path.includes('\\') ||
    path.includes('\0') ||
    EDGE_WHITESPACE_PATTERN.test(path) ||
    segments.some((segment) => segment === '' || segment === '.')
  );
}

/**
 * Canonical order of references: by `artifact_path`, then `artifact_sha256`, `event_id`,
 * `json_pointer` and `package_index_sha256`, comparing UTF-16 code units; an absent optional
 * field sorts before any present value. Returns 0 only for structurally equal references.
 *
 * @example
 * refs.toSorted(compareEvidenceRefs);
 */
export function compareEvidenceRefs(a: EvidenceRef, b: EvidenceRef): number {
  for (const key of ORDER_KEYS) {
    const order = compareOptional(a[key], b[key]);
    if (order !== 0) {
      return order;
    }
  }
  return 0;
}

/**
 * Tells whether a value can take part in the canonical order: a JSON object whose ordering
 * members are each absent or a string. Order is defined only over such values, so callers that
 * hold unvalidated JSON check this before `compareEvidenceRefs`; a value that fails it is a type
 * error for the schema's `items` rule (or MALFORMED_FIELD), never an order error. Comparing
 * unchecked members with `<` coerces them and throws on `{"toString":1,"valueOf":1}` (Owner
 * amendment A-02; WP-03 seeds -435396834 and 20261005).
 *
 * @example
 * isOrderableEvidenceRef({ artifact_path: 'a.json', artifact_sha256: 'b'.repeat(64) }); // true
 * isOrderableEvidenceRef({ artifact_path: { toString: 1 } }); // false
 */
export function isOrderableEvidenceRef(value: unknown): value is EvidenceRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const members = value as Readonly<Record<string, unknown>>;
  return ORDER_KEYS.every((key) => members[key] === undefined || typeof members[key] === 'string');
}

/**
 * Returns a new list in canonical order (duplicates are kept; validation rejects them).
 *
 * @example
 * const evidence_refs = sortEvidenceRefs([ledgerRef, paymentRef]);
 */
export function sortEvidenceRefs(refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  return refs.toSorted(compareEvidenceRefs);
}

/**
 * Validates the reference list held under `field` of a result container. Totally defined
 * over arbitrary JSON: it never throws and reports each problem once with its detail.
 *
 * @example
 * const findings = validateEvidenceRefList(ruleResult, 'evidence_refs', 'inside_package');
 * // [] when well formed; otherwise e.g. [{ violation: 'UNSORTED', detail: '...' }]
 */
export function validateEvidenceRefList(
  container: JsonValue,
  field: string,
  location: ReferenceLocation,
): readonly EvidenceRefFinding[] {
  if (!isJsonObject(container)) {
    return [
      { violation: 'MALFORMED_FIELD', detail: `container is ${describeJson(container)}; expected a JSON object` },
    ];
  }
  const aliasFindings = EVIDENCE_REF_ALIASES.filter((alias) => Object.hasOwn(container, alias)).map((alias) => ({
    violation: 'ALIAS_FIELD' as const,
    detail: `field ${JSON.stringify(alias)} is an alias; BR-RUA-035 requires the field name ${JSON.stringify(field)}`,
  }));
  // Own members only: an inherited name such as `constructor` is not a field of the container.
  const list = Object.hasOwn(container, field) ? container[field] : undefined;
  if (!Array.isArray(list)) {
    const detail = `field ${JSON.stringify(field)} is ${describeJson(list)}; expected an array of evidence references`;
    return [...aliasFindings, { violation: 'MALFORMED_FIELD', detail }];
  }
  const entries: readonly JsonValue[] = list;
  const entryFindings = entries.flatMap((entry, index) => validateEntry(entry, index, location));
  if (entryFindings.length > 0) {
    return [...aliasFindings, ...entryFindings];
  }
  // Every entry passed validateEntry, so each one has the EvidenceRef shape.
  return [...aliasFindings, ...orderFindings(entries as unknown as readonly EvidenceRef[])];
}

/**
 * Applies the result-level rules of BR-RUA-035: `pass` and `fail` need at least one
 * reference. An empty `indeterminate` list is allowed only when the result is "caused entirely
 * by missing evidence": there is at least one reason, and every reason has a
 * `MISSING_EVIDENCE_REASON_CODES` code and names the missing artifact or event. A reason with any
 * other cause makes the empty list a violation, even when it names an artifact.
 *
 * @example
 * validateResultReferences('pass', [], []); // ['MISSING_REFERENCE_FOR_CONCLUSIVE_RESULT']
 * validateResultReferences('indeterminate', [], [{ code: 'ARTIFACT_MISSING', subject: 'G5',
 *   artifact_path: 'ledger/ledger-snapshot.json', detail: 'absent' }]); // []
 */
export function validateResultReferences(
  result: 'pass' | 'fail' | 'indeterminate',
  refs: readonly EvidenceRef[],
  reasons: readonly StructuredReason[],
): readonly EvidenceRefViolation[] {
  if (refs.length > 0) {
    return [];
  }
  if (result !== 'indeterminate') {
    return ['MISSING_REFERENCE_FOR_CONCLUSIVE_RESULT'];
  }
  const entirelyMissingEvidence = reasons.length > 0 && reasons.every(isMissingEvidenceReason);
  return entirelyMissingEvidence ? [] : ['EMPTY_WITHOUT_MISSING_EVIDENCE_REASON'];
}

function isMissingEvidenceReason(reason: StructuredReason): boolean {
  const codes: readonly string[] = MISSING_EVIDENCE_REASON_CODES;
  return codes.includes(reason.code) && (reason.artifact_path !== undefined || reason.event_id !== undefined);
}

function validateEntry(entry: JsonValue, index: number, location: ReferenceLocation): readonly EvidenceRefFinding[] {
  const at = `evidence_refs[${String(index)}]`;
  if (!isJsonObject(entry)) {
    return [{ violation: 'MALFORMED_FIELD', detail: `${at} is ${describeJson(entry)}; expected a JSON object` }];
  }
  // The member name is untrusted text of any length, so the detail quotes it bounded (A-05).
  const unknownFields = Object.keys(entry)
    .filter((key) => !REF_FIELDS.has(key))
    .map((key) =>
      malformed(
        `${at}[${boundedJsonText(key)}] is not a BR-RUA-035 field; expected only ${[...REF_FIELDS].join(', ')}`,
      ),
    );
  return [
    ...unknownFields,
    ...pathFindings(entry, at),
    ...fieldFindings(entry, at),
    ...locationFindings(entry, at, location),
  ];
}

function pathFindings(entry: Readonly<Record<string, JsonValue>>, at: string): readonly EvidenceRefFinding[] {
  const path = entry['artifact_path'];
  if (typeof path !== 'string' || path === '') {
    return [
      malformed(`${at}.artifact_path is ${describeJson(path)}; expected a non-empty package-relative POSIX path`),
    ];
  }
  const violation = classifyArtifactPath(path);
  if (violation === undefined) {
    return [];
  }
  return [
    {
      violation,
      detail: `${at}.artifact_path ${boundedJsonText(path)}; expected a normalized package-relative POSIX path`,
    },
  ];
}

function fieldFindings(entry: Readonly<Record<string, JsonValue>>, at: string): readonly EvidenceRefFinding[] {
  const findings: EvidenceRefFinding[] = [];
  if (!isSha256Hex(entry['artifact_sha256'])) {
    findings.push(
      malformed(`${at}.artifact_sha256 is ${describeJson(entry['artifact_sha256'])}; expected 64 lowercase hex`),
    );
  }
  if (Object.hasOwn(entry, 'event_id') && !isUuid4(entry['event_id'])) {
    findings.push(malformed(`${at}.event_id is ${describeJson(entry['event_id'])}; expected a lowercase UUIDv4`));
  }
  if (Object.hasOwn(entry, 'json_pointer') && !isJsonPointer(entry['json_pointer'])) {
    findings.push(
      malformed(`${at}.json_pointer is ${describeJson(entry['json_pointer'])}; expected an RFC 6901 pointer`),
    );
  }
  if (Object.hasOwn(entry, 'package_index_sha256') && !isSha256Hex(entry['package_index_sha256'])) {
    const value = describeJson(entry['package_index_sha256']);
    findings.push(malformed(`${at}.package_index_sha256 is ${value}; expected 64 lowercase hex`));
  }
  return findings;
}

function locationFindings(
  entry: Readonly<Record<string, JsonValue>>,
  at: string,
  location: ReferenceLocation,
): readonly EvidenceRefFinding[] {
  if (location === 'inside_package' || Object.hasOwn(entry, 'package_index_sha256')) {
    return [];
  }
  return [
    {
      violation: 'CROSS_PACKAGE_WITHOUT_INDEX_DIGEST',
      detail: `${at} is held outside every package but has no package_index_sha256; expected the referenced package's index digest`,
    },
  ];
}

function orderFindings(refs: readonly EvidenceRef[]): readonly EvidenceRefFinding[] {
  const findings: EvidenceRefFinding[] = [];
  const firstIndexOf = new Map<string, number>();
  refs.forEach((ref, index) => {
    const identity = JSON.stringify(ORDER_KEYS.map((key) => ref[key] ?? null));
    const earlier = firstIndexOf.get(identity);
    if (earlier !== undefined) {
      // The detail names both positions and quotes the path bounded; the identity itself may be
      // megabytes of untrusted text (WP-00 review round 2, A-05 policy 1).
      findings.push({
        violation: 'DUPLICATE',
        detail: `evidence_refs[${String(index)}] repeats an earlier reference evidence_refs[${String(earlier)}] (artifact_path ${boundedJsonText(ref.artifact_path)}); expected each reference once`,
      });
    }
    firstIndexOf.set(identity, earlier ?? index);
    const previous = refs[index - 1];
    if (previous !== undefined && compareEvidenceRefs(previous, ref) > 0) {
      findings.push({
        violation: 'UNSORTED',
        detail: `evidence_refs[${String(index)}] sorts before evidence_refs[${String(index - 1)}]; expected canonical order`,
      });
    }
  });
  return findings;
}

function compareOptional(a: string | undefined, b: string | undefined): number {
  if (a === b) {
    return 0;
  }
  if (a === undefined) {
    return -1;
  }
  if (b === undefined) {
    return 1;
  }
  return a < b ? -1 : 1;
}

function isJsonPointer(value: JsonValue | undefined): boolean {
  return typeof value === 'string' && JSON_POINTER_PATTERN.test(value);
}

function malformed(detail: string): EvidenceRefFinding {
  return { violation: 'MALFORMED_FIELD', detail };
}
