// Gate G2 `traceability` (BR-RUA-008; AC-RUA-041; D-28; design §8.3). Verified when every
// verdict-critical record carries the active execution identity and trial, every manifest
// reference resolves to the frozen digest, every causal predecessor resolves and, when a frozen
// package is re-evaluated, every evidence reference resolves to indexed bytes. Invalid when a
// record names another execution or trial, a manifest reference names another digest, the
// consumer rejected the trial message for an identity or digest mismatch, or a re-evaluated
// reference names other bytes. Unverified when correlation is missing, the consumer rejected the
// message for missing correlation, a predecessor does not resolve, a manifest is unusable, or a
// re-evaluated reference names unindexed bytes. Verdict-critical records are the subject's.

import { isJsonArray, isJsonObject } from '../record-contract/json-value.ts';
import type { JsonValue, Sha256Hex } from '../record-contract/primitives.ts';
import type { ArtifactClass } from '../record-contract/records/group-c/vocabulary.ts';
import { isUnitFile } from './artifact-roles.ts';
import { checkCoreDigests } from './core-digests.ts';
import { artifactRef, assembleGate, eventRef, reasonAt, recordRef } from './gate-assessment.ts';
import type { GateCause } from './gate-assessment.ts';
import { findingReason } from './ingestion-findings.ts';
import type {
  EvidenceScope,
  GateAssessment,
  IngestedArtifact,
  IngestedEvidence,
  IngestedRecord,
} from './ingestion-model.ts';
import { namesOtherExecution, ownString } from './record-correlation.ts';

const SUBJECT = 'BR-RUA-008';
/** D-28: consumer rejections that prove the message belonged to another execution or trial. */
const MISMATCH_REJECTIONS: ReadonlySet<string | undefined> = new Set([
  'EXECUTION_IDENTITY_MISMATCH',
  'TRIAL_MANIFEST_DIGEST_MISMATCH',
]);
const MANIFEST_CLASSES: readonly ArtifactClass[] = ['execution_manifest', 'trial_manifest'];

/**
 * Assesses G2 over ingested evidence.
 *
 * @example
 * assessTraceability(ingestEvidence(input, validator)).value; // 'verified'
 */
export function assessTraceability(evidence: IngestedEvidence): GateAssessment<'traceability'> {
  const subject = [...evidence.artifacts.values()].filter((artifact) => artifact.origin === 'subject');
  const causes = [
    ...subject.flatMap((artifact) => foreignRecordCauses(artifact, evidence.scope)),
    ...digestCauses(subject, evidence.scope),
    ...rejectionCauses(evidence),
    ...correlationCauses(evidence, subject),
    ...unresolvedCauses(evidence),
    ...manifestCauses(evidence, subject),
    ...(evidence.scope.reevaluation
      ? subject.flatMap((artifact) => referenceCauses(artifact, evidence.indexed_digests))
      : []),
  ];
  const manifests = subject.filter((artifact) => MANIFEST_CLASSES.some((name) => name === artifact.artifact_class));
  return assembleGate('traceability', causes, manifests.map(artifactRef));
}

function usableRecords(artifact: IngestedArtifact): readonly IngestedRecord[] {
  return artifact.records.filter((record) => record.validity !== 'schema_invalid');
}

// Another execution: any execution id member other than the active one. Another trial: a record
// of the trial directory naming a different trial, or any probe record naming a trial (D-06).
function foreignRecordCauses(artifact: IngestedArtifact, scope: EvidenceScope): readonly GateCause[] {
  return usableRecords(artifact).flatMap((record) => {
    const execution = scope.execution !== undefined && namesOtherExecution(record.value, scope.execution);
    if (!execution && !namesOtherTrial(artifact, record.value, scope)) {
      return [];
    }
    const ref = recordRef(artifact, record);
    const code = execution ? 'EXECUTION_IDENTITY_MISMATCH' : 'TRIAL_IDENTITY_MISMATCH';
    const detail = `expected the active ${execution ? 'execution' : 'trial'} identity; a record of ${artifact.path} names another`;
    return [{ value: 'invalid', reason: reasonAt(SUBJECT, code, detail, ref), refs: [ref] }];
  });
}

function namesOtherTrial(artifact: IngestedArtifact, value: JsonValue, scope: EvidenceScope): boolean {
  const named = ownString(value, 'trial_id');
  if (named === undefined || !isUnitFile(artifact)) {
    return false;
  }
  return scope.subject_kind === 'probe' || (scope.trial !== undefined && named !== scope.trial.trial_id);
}

// A manifest reference of a subject record that names another digest (design §8.2 I3, without
// the evidence index, which is G8's concern).
function digestCauses(subject: readonly IngestedArtifact[], scope: EvidenceScope): readonly GateCause[] {
  return checkCoreDigests(subject, scope, undefined).map((finding) => ({
    value: 'invalid',
    reason: findingReason(finding),
    refs: subject.filter((artifact) => artifact.path === finding.artifact_path).map(artifactRef),
  }));
}

function rejectionCauses(evidence: IngestedEvidence): readonly GateCause[] {
  return evidence.events.subject
    .filter((event) => event.record.record_type === 'trial_message_rejected')
    .flatMap((event) => {
      const rejection = ownString(event.record as unknown as JsonValue, 'reason');
      const mismatch = MISMATCH_REJECTIONS.has(rejection);
      if (!mismatch && rejection !== 'CORRELATION_MISSING') {
        return [];
      }
      const ref = eventRef(event);
      const detail = `expected the trial message to be accepted; the consumer rejected it with ${String(rejection)}`;
      const reason = reasonAt(SUBJECT, 'TRIAL_MESSAGE_REJECTED', detail, ref);
      return [{ value: mismatch ? 'invalid' : 'unverified', reason, refs: [ref] } satisfies GateCause];
    });
}

function correlationCauses(evidence: IngestedEvidence, subject: readonly IngestedArtifact[]): readonly GateCause[] {
  return subject.flatMap((artifact) =>
    evidence.findings
      .filter((finding) => finding.code === 'CORRELATION_MISSING' && finding.artifact_path === artifact.path)
      .map((finding) => ({ value: 'unverified', reason: findingReason(finding), refs: [artifactRef(artifact)] })),
  );
}

function unresolvedCauses(evidence: IngestedEvidence): readonly GateCause[] {
  return evidence.events.subject.flatMap((event) => {
    const missing = evidence.events.unresolved_causation.get(event.record.event_id);
    if (missing === undefined) {
      return [];
    }
    // The predecessor itself is absent, so the dependent event is what can be cited.
    const ref = eventRef(event);
    const detail = `expected every causal predecessor of ${event.record.record_type} to resolve; absent ${missing.join(', ')}`;
    return [{ value: 'unverified', reason: reasonAt(SUBJECT, 'CAUSAL_PREDECESSOR_MISSING', detail, ref), refs: [ref] }];
  });
}

function manifestCauses(evidence: IngestedEvidence, subject: readonly IngestedArtifact[]): readonly GateCause[] {
  const unresolved = [
    ...(evidence.scope.execution === undefined ? ['execution_manifest'] : []),
    ...(evidence.scope.subject_kind === 'trial' && evidence.scope.trial === undefined ? ['trial_manifest'] : []),
  ];
  return evidence.expected
    .filter((expected) => unresolved.includes(expected.artifact_class))
    .map((expected) => {
      const artifact = subject.find((candidate) => candidate.path === expected.path);
      if (artifact === undefined) {
        const detail = `expected the ${expected.artifact_class} to correlate records against; it is absent`;
        const reason = reasonAt(SUBJECT, 'ARTIFACT_MISSING', detail, { artifact_path: expected.path });
        return { value: 'unverified', reason, refs: [] };
      }
      const ref = artifactRef(artifact);
      const detail = `expected a schema-valid ${expected.artifact_class}; ${artifact.path} is unusable`;
      return { value: 'unverified', reason: reasonAt(SUBJECT, 'MANIFEST_UNUSABLE', detail, ref), refs: [ref] };
    });
}

// Re-evaluation: every in-package evidence reference of a subject record must name indexed bytes.
function referenceCauses(
  artifact: IngestedArtifact,
  indexed: ReadonlyMap<string, Sha256Hex> | undefined,
): readonly GateCause[] {
  return usableRecords(artifact).flatMap((record) => {
    const refs =
      isJsonObject(record.value) && Object.hasOwn(record.value, 'evidence_refs')
        ? record.value['evidence_refs']
        : undefined;
    const entries: readonly JsonValue[] = isJsonArray(refs) ? refs : [];
    return entries.flatMap((entry) => referenceCause(artifact, record, entry, indexed));
  });
}

function referenceCause(
  artifact: IngestedArtifact,
  record: IngestedRecord,
  entry: JsonValue,
  indexed: ReadonlyMap<string, Sha256Hex> | undefined,
): readonly GateCause[] {
  const path = ownString(entry, 'artifact_path');
  const digest = ownString(entry, 'artifact_sha256');
  // A reference that pins another package's index points outside this package's bytes.
  if (path === undefined || digest === undefined || ownString(entry, 'package_index_sha256') !== undefined) {
    return [];
  }
  const indexedDigest = indexed?.get(path);
  if (indexedDigest === digest) {
    return [];
  }
  const ref = recordRef(artifact, record);
  if (indexedDigest === undefined) {
    const detail = `expected every evidence reference to name indexed bytes; ${path} is not in the evidence index`;
    return [{ value: 'unverified', reason: reasonAt(SUBJECT, 'EVIDENCE_REF_UNRESOLVED', detail, ref), refs: [ref] }];
  }
  const detail = `expected ${path} at the indexed digest ${indexedDigest}; the reference names ${digest}`;
  return [{ value: 'invalid', reason: reasonAt(SUBJECT, 'EVIDENCE_REF_DIGEST_MISMATCH', detail, ref), refs: [ref] }];
}
