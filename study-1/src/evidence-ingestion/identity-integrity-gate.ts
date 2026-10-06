// Gate G3 `identity_integrity` (INV-RUA-001; AC-RUA-017; design §8.3). Invalid on proven
// caller-generated reuse: an `attempt_id` or `provider_request_id` created twice, spanning two
// attempts, or appearing in another trial. Unverified when identity evidence is missing: a subject
// record references an attempt nobody registered, the caller journal is absent, unparseable or
// gapped, or an earlier trial's evidence that bounds the execution scope cannot be read.

import type { GateAssessment, IngestedEvidence, IngestedArtifact } from './ingestion-model.ts';
import { artifactRef, assembleGate, reasonAt } from './gate-assessment.ts';
import type { GateCause } from './gate-assessment.ts';
import { findingReason } from './ingestion-findings.ts';

const SUBJECT = 'INV-RUA-001';

/**
 * Assesses G3 over ingested evidence.
 *
 * @example
 * assessIdentityIntegrity(ingestEvidence(input, validator)).value; // 'verified'
 */
export function assessIdentityIntegrity(evidence: IngestedEvidence): GateAssessment<'identity_integrity'> {
  const callerJournal = [...evidence.artifacts.values()].find(
    (artifact) => artifact.origin === 'subject' && artifact.artifact_class === 'caller_journal',
  );
  const causes = [
    ...reuseCauses(evidence),
    ...unregisteredCauses(evidence),
    ...callerJournalCauses(evidence, callerJournal),
    ...[...evidence.artifacts.values()].flatMap(scopeCauses),
  ];
  return assembleGate('identity_integrity', causes, callerJournal === undefined ? [] : [artifactRef(callerJournal)]);
}

function reuseCauses(evidence: IngestedEvidence): readonly GateCause[] {
  return evidence.identities.caller_collisions.map((collision) => {
    const detail = `expected ${collision.kind} ${collision.id} to be unique in the execution scope; created by ${String(collision.origin_event_ids.length)} events across partitions ${collision.partitions.join(', ')}`;
    return {
      value: 'invalid',
      reason: reasonAt(SUBJECT, 'CALLER_IDENTITY_REUSED', detail, collision.refs[0]),
      refs: collision.refs,
    };
  });
}

function unregisteredCauses(evidence: IngestedEvidence): readonly GateCause[] {
  return evidence.identities.unregistered_attempts.map((attempt) => {
    const detail = `expected attempt ${attempt.attempt_id} to have an attempt_registered event; none was read`;
    return {
      value: 'unverified',
      reason: reasonAt(SUBJECT, 'ATTEMPT_UNREGISTERED', detail, attempt.ref),
      refs: [attempt.ref],
    };
  });
}

function callerJournalCauses(
  evidence: IngestedEvidence,
  callerJournal: IngestedArtifact | undefined,
): readonly GateCause[] {
  const expected = evidence.expected.find((artifact) => artifact.artifact_class === 'caller_journal');
  if (expected === undefined) {
    return [];
  }
  if (callerJournal === undefined) {
    const detail = `expected the caller journal to hold every attempt registration; ${expected.path} is absent`;
    return [
      {
        value: 'unverified',
        reason: reasonAt(SUBJECT, 'ARTIFACT_MISSING', detail, { artifact_path: expected.path }),
        refs: [],
      },
    ];
  }
  const ref = artifactRef(callerJournal);
  const unreadable = evidence.findings.filter(
    (finding) =>
      finding.artifact_path === callerJournal.path &&
      (finding.code === 'ARTIFACT_UNPARSEABLE' || finding.code === 'SOURCE_SEQUENCE_GAP'),
  );
  return unreadable.map((finding) => ({ value: 'unverified', reason: findingReason(finding), refs: [ref] }));
}

// Earlier trials bound the scope in which caller identities must be unique: one that cannot be
// read leaves reuse unprovable either way.
function scopeCauses(artifact: IngestedArtifact): readonly GateCause[] {
  const readable =
    artifact.parse_status === 'parsed' && artifact.records.every((record) => record.validity !== 'schema_invalid');
  if (artifact.origin !== 'execution_scope' || readable) {
    return [];
  }
  const ref = artifactRef(artifact);
  const detail = `expected the execution scope's earlier evidence to be readable; ${artifact.path} has unreadable records`;
  return [{ value: 'unverified', reason: reasonAt(SUBJECT, 'IDENTITY_SCOPE_INCOMPLETE', detail, ref), refs: [ref] }];
}
