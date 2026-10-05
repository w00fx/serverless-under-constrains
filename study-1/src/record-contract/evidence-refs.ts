// Evidence references (BR-RUA-035, AC-RUA-048). A reference names an artifact by a
// normalized package-relative POSIX path and its digest. Lists are sorted canonically and
// duplicate-free; a conclusive result carries at least one reference; an indeterminate
// result may carry none only when a structured reason names the missing artifact or event.

import { isSha256Hex } from './digests.ts';
import { isUuid4 } from './identifiers.ts';
import { describeJson, isJsonObject } from './json-value.ts';
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

const REF_FIELDS: ReadonlySet<string> = new Set([
  'artifact_path',
  'artifact_sha256',
  'event_id',
  'json_pointer',
  'package_index_sha256',
]);
const JSON_POINTER_PATTERN = /^(\/([^/~]|~[01])*)*$/;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;

/**
 * Classifies a path against BR-RUA-035; `undefined` means it is a normalized
 * package-relative POSIX path.
 *
 * @example
 * classifyArtifactPath('/tmp/x.json'); // 'ABSOLUTE_PATH'
 * classifyArtifactPath('trials/t/../x'); // 'PARENT_TRAVERSAL'
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
  if (path.includes('\\') || segments.some((segment) => segment === '' || segment === '.')) {
    return 'NON_NORMALIZED_PATH';
  }
  return undefined;
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
  const keys = ['artifact_path', 'artifact_sha256', 'event_id', 'json_pointer', 'package_index_sha256'] as const;
  for (const key of keys) {
    const order = compareOptional(a[key], b[key]);
    if (order !== 0) {
      return order;
    }
  }
  return 0;
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
  const list = container[field];
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
 * reference; an empty `indeterminate` list needs a reason naming the missing artifact or event.
 *
 * @example
 * validateResultReferences('pass', [], []); // ['MISSING_REFERENCE_FOR_CONCLUSIVE_RESULT']
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
  const namesMissingEvidence = reasons.some(
    (reason) => reason.artifact_path !== undefined || reason.event_id !== undefined,
  );
  return namesMissingEvidence ? [] : ['EMPTY_WITHOUT_MISSING_EVIDENCE_REASON'];
}

function validateEntry(entry: JsonValue, index: number, location: ReferenceLocation): readonly EvidenceRefFinding[] {
  const at = `evidence_refs[${String(index)}]`;
  if (!isJsonObject(entry)) {
    return [{ violation: 'MALFORMED_FIELD', detail: `${at} is ${describeJson(entry)}; expected a JSON object` }];
  }
  const unknownFields = Object.keys(entry)
    .filter((key) => !REF_FIELDS.has(key))
    .map((key) => malformed(`${at}.${key} is not a BR-RUA-035 field; expected only ${[...REF_FIELDS].join(', ')}`));
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
      detail: `${at}.artifact_path ${JSON.stringify(path)}; expected a normalized package-relative POSIX path`,
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
  const seen = new Set<string>();
  refs.forEach((ref, index) => {
    const identity = JSON.stringify([
      ref.artifact_path,
      ref.artifact_sha256,
      ref.event_id,
      ref.json_pointer,
      ref.package_index_sha256,
    ]);
    if (seen.has(identity)) {
      findings.push({
        violation: 'DUPLICATE',
        detail: `evidence_refs[${String(index)}] repeats an earlier reference ${identity}`,
      });
    }
    seen.add(identity);
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
