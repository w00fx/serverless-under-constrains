// Construction, ordering and projection of BR-RUA-034 ingestion findings (design §8.2). Every
// finding names the spec rule that classifies it, a bounded detail that quotes the offending value
// and the expected shape, and how many occurrences it aggregates (Owner amendment A-12: counts
// scale with input, so findings are aggregated rather than emitted per occurrence).

import { classifyArtifactPath } from '../record-contract/evidence-refs.ts';
import { isUuid4 } from '../record-contract/identifiers.ts';
import { boundedText } from '../record-contract/json-value.ts';
import type { StructuredReason } from '../record-contract/primitives.ts';
import type { IngestionFindingCode } from '../record-contract/records/group-c/vocabulary.ts';
import type { IngestionFinding } from './ingestion-model.ts';

/** The spec rule each finding code comes from. */
const FINDING_SUBJECTS: Readonly<Record<IngestionFindingCode, string>> = {
  EQUIVALENT_DUPLICATE_COLLAPSED: 'BR-RUA-034',
  CONFLICTING_EVENT_CONTENT: 'BR-RUA-034',
  CONFLICTING_SOURCE_SEQUENCE: 'BR-RUA-034',
  SOURCE_SEQUENCE_GAP: 'BR-RUA-034',
  CAUSAL_PREDECESSOR_MISSING: 'BR-RUA-034',
  DUPLICATE_LEDGER_TRANSACTION_ID: 'BR-RUA-034',
  LEDGER_PAGINATION_INCOMPLETE: 'BR-RUA-034',
  CORE_FILE_DIGEST_MISMATCH: 'BR-RUA-034',
  LEDGER_LARGER_THAN_EXPECTED: 'BR-RUA-034',
  ARTIFACT_MISSING: 'BR-RUA-037',
  ARTIFACT_UNPARSEABLE: 'BR-RUA-033',
  RECORD_SCHEMA_INVALID: 'BR-RUA-033',
  CORRELATION_MISSING: 'BR-RUA-008',
};

/** How much of the first occurrence an aggregated detail quotes. */
const AGGREGATED_FIRST_LIMIT = 150;

/** Where a finding points; every member is optional and validated before it is kept. */
export interface FindingLocation {
  readonly artifact_path?: string;
  readonly event_id?: unknown;
  readonly source_instance_key?: string;
  readonly occurrences?: number;
}

/**
 * Builds a finding. An `artifact_path` that is not a normalized package-relative path, or an
 * `event_id` that is not a UUIDv4, is left out (it is untrusted text), so a finding always
 * serializes as a valid structured reason; the detail is cut to a bounded length.
 *
 * @example
 * ingestionFinding('SOURCE_SEQUENCE_GAP', 'sequence 3 is absent; expected 1..5', { occurrences: 1 });
 */
export function ingestionFinding(
  code: IngestionFindingCode,
  detail: string,
  location: FindingLocation = {},
): IngestionFinding {
  const path = location.artifact_path;
  const pathIsValid = path !== undefined && path !== '' && classifyArtifactPath(path) === undefined;
  return {
    code,
    subject: FINDING_SUBJECTS[code],
    ...(pathIsValid ? { artifact_path: path } : {}),
    ...(isUuid4(location.event_id) ? { event_id: location.event_id } : {}),
    ...(location.source_instance_key === undefined ? {} : { source_instance_key: location.source_instance_key }),
    detail: boundedText(detail),
    occurrences: location.occurrences ?? 1,
  };
}

/**
 * The structured reason a finding contributes to a gate: the finding without its aggregation
 * members, so it matches the catalogue's closed `structured_reason` shape.
 *
 * @example
 * findingReason(finding); // { code, subject, artifact_path?, event_id?, detail }
 */
export function findingReason(finding: IngestionFinding): StructuredReason {
  return {
    code: finding.code,
    subject: finding.subject,
    ...(finding.artifact_path === undefined ? {} : { artifact_path: finding.artifact_path }),
    ...(finding.event_id === undefined ? {} : { event_id: finding.event_id }),
    detail: finding.detail,
  };
}

/**
 * Deterministic order: by code, artifact path, source instance, event id, then detail.
 *
 * @example
 * sortFindings([gapFinding, collapsedFinding]); // collapsed (C...) sorts after ARTIFACT_*, etc.
 */
export function sortFindings(findings: readonly IngestionFinding[]): readonly IngestionFinding[] {
  return findings.toSorted(compareFindings);
}

function compareFindings(a: IngestionFinding, b: IngestionFinding): number {
  const keys = [
    [a.code, b.code],
    [a.artifact_path ?? '', b.artifact_path ?? ''],
    [a.source_instance_key ?? '', b.source_instance_key ?? ''],
    [a.event_id ?? '', b.event_id ?? ''],
    [a.detail, b.detail],
  ] as const;
  const differing = keys.find(([left, right]) => left !== right);
  if (differing === undefined) {
    return 0;
  }
  return differing[0] < differing[1] ? -1 : 1;
}

/**
 * A detail for an aggregated finding: the first occurrence described in full, then how many more.
 *
 * @example
 * aggregatedDetail('line 4: ...', 3); // 'line 4: ... (and 2 more)'
 */
export function aggregatedDetail(first: string, occurrences: number): string {
  // The first occurrence is cut shorter than a whole detail, so the count always survives.
  const described = boundedText(first, AGGREGATED_FIRST_LIMIT);
  return occurrences > 1 ? `${described} (and ${String(occurrences - 1)} more)` : described;
}

/**
 * Merges findings that share a code, artifact and source instance into one, so the finding count
 * is bounded by the evidence's structure rather than by its size (Owner amendment A-12): the
 * merged finding keeps the first one's event and detail, notes how many more there were, and
 * sums their occurrences. Order of first appearance is kept.
 *
 * @example
 * mergeFindings([gapA, gapB]); // one SOURCE_SEQUENCE_GAP when both name one artifact and instance
 */
export function mergeFindings(findings: readonly IngestionFinding[]): readonly IngestionFinding[] {
  const merged = new Map<string, IngestionFinding[]>();
  for (const finding of findings) {
    const key = JSON.stringify([finding.code, finding.artifact_path ?? '', finding.source_instance_key ?? '']);
    const group = merged.get(key) ?? [];
    group.push(finding);
    merged.set(key, group);
  }
  return [...merged.values()].map(mergeGroup);
}

function mergeGroup(group: readonly IngestionFinding[]): IngestionFinding {
  const [first, ...rest] = group as readonly [IngestionFinding, ...IngestionFinding[]];
  if (rest.length === 0) {
    return first;
  }
  return {
    ...first,
    detail: aggregatedDetail(first.detail, group.length),
    occurrences: group.reduce((total, finding) => total + finding.occurrences, 0),
  };
}
