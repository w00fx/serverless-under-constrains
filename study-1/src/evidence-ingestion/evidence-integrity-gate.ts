// Gate G8 `evidence_integrity` (BR-RUA-034; INV-RUA-001; AC-RUA-017 case 3; design §8.3).
// Invalid on unparseable bytes or a schema-invalid record in required (or conditionally required)
// evidence, a conflicting event or source sequence, a core-file digest mismatch, or a
// provider-generated identity collision. Unverified when a frozen package is re-evaluated without
// its evidence index. Gaps, collapsed duplicates and absent artifacts are other gates' concern.
// The gate judges the evaluated trial's or probe's evidence: its expected artifacts and, in a
// re-evaluation, every file its evidence index covers. A conflict or digest mismatch found only in
// a supplementary file (readiness journals, the A-09 provider partition, derived files) is still
// reported as a finding but never decides this gate (addendum §2.2; review finding WP-12 R2).

import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import { boundedText } from '../record-contract/json-value.ts';
import type { IngestionFindingCode } from '../record-contract/records/group-c/vocabulary.ts';
import { artifactRef, assembleGate, reasonAt } from './gate-assessment.ts';
import type { GateCause } from './gate-assessment.ts';
import { findingReason } from './ingestion-findings.ts';
import type { GateAssessment, IngestedArtifact, IngestedEvidence, IngestionFinding } from './ingestion-model.ts';

/** Findings that invalidate the gate wherever they are. */
const INVALIDATING_CODES: ReadonlySet<IngestionFindingCode> = new Set<IngestionFindingCode>([
  'CONFLICTING_EVENT_CONTENT',
  'CONFLICTING_SOURCE_SEQUENCE',
  'CORE_FILE_DIGEST_MISMATCH',
]);
/** Findings that invalidate the gate on required or conditional evidence. */
const UNREADABLE_CODES: ReadonlySet<IngestionFindingCode> = new Set<IngestionFindingCode>([
  'ARTIFACT_UNPARSEABLE',
  'RECORD_SCHEMA_INVALID',
]);

/**
 * Assesses G8 over ingested evidence.
 *
 * @example
 * assessEvidenceIntegrity(ingestEvidence(input, validator)).value; // 'verified'
 */
export function assessEvidenceIntegrity(evidence: IngestedEvidence): GateAssessment<'evidence_integrity'> {
  const integral = [...evidence.artifacts.values()].filter(isRequiredEvidence);
  const causes = [
    ...evidence.findings.flatMap((finding) => findingCauses(finding, evidence)),
    ...evidence.identities.provider_collisions.map((collision) => {
      // Values quoted from evidence bytes are bounded (A-12; review finding WP-12 R3).
      const detail = `expected provider-generated ${collision.kind} ${boundedText(collision.id)} to be unique; created by ${String(collision.origin_event_ids.length)} events across partitions ${boundedText(collision.partitions.join(', '))}`;
      const reason = reasonAt('INV-RUA-001', 'PROVIDER_IDENTITY_COLLISION', detail, collision.refs[0]);
      return { value: 'invalid', reason, refs: collision.refs } satisfies GateCause;
    }),
    ...indexCauses(evidence),
  ];
  return assembleGate('evidence_integrity', causes, integral.map(artifactRef));
}

function isRequiredEvidence(artifact: IngestedArtifact): boolean {
  return (
    artifact.origin === 'subject' && (artifact.requirement === 'required' || artifact.requirement === 'conditional')
  );
}

// The subject's own artifacts, plus any file the re-evaluated evidence index pins: those bytes are
// the trial's frozen evidence even when the expected set does not name them (design §7 index scope).
function isJudgedEvidence(artifact: IngestedArtifact, evidence: IngestedEvidence): boolean {
  return artifact.origin === 'subject' || evidence.indexed_digests?.has(artifact.path) === true;
}

function findingCauses(finding: IngestionFinding, evidence: IngestedEvidence): readonly GateCause[] {
  const artifact = finding.artifact_path === undefined ? undefined : evidence.artifacts.get(finding.artifact_path);
  // Every finding that can invalidate names an artifact that was read: conflicts and mismatches
  // are found in read records, and unreadable evidence counts only when it is required.
  if (artifact === undefined) {
    return [];
  }
  const invalidating =
    (INVALIDATING_CODES.has(finding.code) && isJudgedEvidence(artifact, evidence)) ||
    (UNREADABLE_CODES.has(finding.code) && isRequiredEvidence(artifact));
  if (!invalidating) {
    return [];
  }
  const ref: EvidenceRef = {
    ...artifactRef(artifact),
    ...(finding.event_id === undefined ? {} : { event_id: finding.event_id }),
  };
  return [{ value: 'invalid', reason: findingReason(finding), refs: [ref] }];
}

// An empty index cannot vouch for any byte; the index is what a re-evaluation checks against.
function indexCauses(evidence: IngestedEvidence): readonly GateCause[] {
  // The digests are given exactly when a frozen package is re-evaluated.
  if (evidence.indexed_digests === undefined || evidence.indexed_digests.size > 0) {
    return [];
  }
  const detail = 'expected the evidence index of the frozen package to re-evaluate against; none was given';
  return [{ value: 'unverified', reason: reasonAt('BR-RUA-034', 'EVIDENCE_INDEX_MISSING', detail), refs: [] }];
}
