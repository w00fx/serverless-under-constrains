// How a validity gate's value is assembled from its causes (design §8.3): `invalid` wins over
// `unverified`, which wins over `verified`. The gate carries the reasons and references of the
// causes that decided its value only, merged per code and artifact so their number does not
// scale with the evidence (A-12), with references in canonical order and duplicate-free
// (BR-RUA-035). A gate made unverified only by absent evidence carries no reference and an
// ARTIFACT_MISSING reason naming what is absent (AC-RUA-048).

import { compareEvidenceRefs, sortEvidenceRefs } from '../record-contract/evidence-refs.ts';
import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import type { StructuredReason } from '../record-contract/primitives.ts';
import type { GateId } from '../record-contract/records/group-c/vocabulary.ts';
import { isUuid4 } from '../record-contract/identifiers.ts';
import { aggregatedDetail } from './ingestion-findings.ts';
import type { GateAssessment, IndexedEvent, IngestedArtifact, IngestedRecord } from './ingestion-model.ts';
import { ownString } from './record-correlation.ts';

/** One reason a gate is not verified, with the evidence it cites. */
export interface GateCause {
  readonly value: 'invalid' | 'unverified';
  readonly reason: StructuredReason;
  readonly refs: readonly EvidenceRef[];
}

/**
 * The gate's value, reasons and references from its causes; `verifiedRefs` are cited when no
 * cause applies.
 *
 * @example
 * assembleGate('traceability', [], [executionManifestRef]); // { value: 'verified', reasons: [], ... }
 */
export function assembleGate<G extends GateId>(
  gate: G,
  causes: readonly GateCause[],
  verifiedRefs: readonly EvidenceRef[],
): GateAssessment<G> {
  const invalid = causes.filter((cause) => cause.value === 'invalid');
  const deciding = invalid.length > 0 ? invalid : causes;
  const [first] = deciding;
  if (first === undefined) {
    return { gate, value: 'verified', reasons: [], evidence_refs: uniqueRefs(verifiedRefs) };
  }
  return {
    gate,
    value: first.value,
    reasons: mergeReasons(deciding.map((cause) => cause.reason)),
    evidence_refs: uniqueRefs(deciding.flatMap((cause) => cause.refs)),
  };
}

/**
 * The reference to a whole artifact.
 *
 * @example
 * artifactRef(artifact); // { artifact_path: artifact.path, artifact_sha256: artifact.sha256 }
 */
export function artifactRef(artifact: Pick<IngestedArtifact, 'path' | 'sha256'>): EvidenceRef {
  return { artifact_path: artifact.path, artifact_sha256: artifact.sha256 };
}

/**
 * The reference to one record: its artifact, plus its `event_id` when it is an event.
 *
 * @example
 * recordRef(callerJournal, callerJournal.records[0]); // { artifact_path, artifact_sha256, event_id }
 */
export function recordRef(artifact: Pick<IngestedArtifact, 'path' | 'sha256'>, record: IngestedRecord): EvidenceRef {
  const eventId = ownString(record.value, 'event_id');
  return isUuid4(eventId) ? { ...artifactRef(artifact), event_id: eventId } : artifactRef(artifact);
}

/**
 * The reference to one indexed event.
 *
 * @example
 * eventRef(event); // { artifact_path, artifact_sha256, event_id }
 */
export function eventRef(event: IndexedEvent): EvidenceRef {
  return {
    artifact_path: event.artifact_path,
    artifact_sha256: event.artifact_sha256,
    event_id: event.record.event_id,
  };
}

/**
 * A reason located at a reference: its artifact and, for an event, its id.
 *
 * @example
 * reasonAt('BR-RUA-008', 'TRIAL_IDENTITY_MISMATCH', 'expected ...', ref);
 */
export function reasonAt(
  subject: string,
  code: string,
  detail: string,
  ref?: Pick<EvidenceRef, 'artifact_path' | 'event_id'>,
): StructuredReason {
  return {
    code,
    subject,
    ...(ref === undefined ? {} : { artifact_path: ref.artifact_path }),
    ...(ref?.event_id === undefined ? {} : { event_id: ref.event_id }),
    detail,
  };
}

function uniqueRefs(refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  const unique: EvidenceRef[] = [];
  for (const ref of sortEvidenceRefs(refs)) {
    const previous = unique.at(-1);
    if (previous === undefined || compareEvidenceRefs(previous, ref) !== 0) {
      unique.push(ref);
    }
  }
  return unique;
}

function mergeReasons(reasons: readonly StructuredReason[]): readonly StructuredReason[] {
  const groups = new Map<string, { readonly head: StructuredReason; count: number }>();
  for (const reason of reasons) {
    const key = JSON.stringify([reason.code, reason.artifact_path ?? '']);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { head: reason, count: 1 });
      continue;
    }
    group.count += 1;
  }
  const merged = [...groups.values()].map(({ head, count }) =>
    count === 1 ? head : { ...head, detail: aggregatedDetail(head.detail, count) },
  );
  return merged.toSorted(compareReasons);
}

function compareReasons(a: StructuredReason, b: StructuredReason): number {
  const left = [a.code, a.artifact_path ?? '', a.event_id ?? '', a.detail].join('\u0000');
  const right = [b.code, b.artifact_path ?? '', b.event_id ?? '', b.detail].join('\u0000');
  return left < right ? -1 : 1;
}
