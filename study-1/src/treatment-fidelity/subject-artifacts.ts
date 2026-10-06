// Whether the subject artifacts a condition reads (journals, ledger, state) are complete, and which ingestion findings touch the
// evidence a result cites (BR-RUA-034, design §8.10 "affected_by"). A gapped source instance, a
// conflicting event or sequence, unreadable bytes or an unresolved causal predecessor makes every
// check relying on that evidence indeterminate: a conclusive result that cites such evidence is
// downgraded, which is the "unaffected" requirement of BR-RUA-027.

import { artifactRef } from '../evidence-ingestion/gate-assessment.ts';
import type { IngestedArtifact, IngestedEvidence, IngestionFinding } from '../evidence-ingestion/ingestion-model.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import type { EvidenceUnit, UNIT_PATHS } from '../evidence-package/package-layout.ts';
import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import type { StructuredReason } from '../record-contract/primitives.ts';
import type { IngestionFindingCode } from '../record-contract/records/group-c/vocabulary.ts';

/** The subject artifacts treatment fidelity and the probe verdict read, by class. */
export type ReadArtifactClass =
  | 'caller_journal'
  | 'provider_journal'
  | 'controller_journal'
  | 'runner_journal'
  | 'ledger_snapshot'
  | 'settlement_samples'
  | 'provider_trial_configuration'
  | 'treatment_state_snapshot';

/** A subject artifact a check reads: where it should be, and whether its records can be trusted complete. */
export interface SubjectArtifactState {
  readonly artifact_class: ReadArtifactClass;
  /** The expected path, present or not. */
  readonly path: string;
  /** The whole-artifact reference, when the artifact was given. */
  readonly ref?: EvidenceRef;
  /** Present, parsed, and free of any finding that could hide or alter one of its events. */
  readonly complete: boolean;
}

/**
 * Findings that never change what a check can conclude: an equivalent duplicate was collapsed to
 * one copy, and a ledger larger than expected was read whole (design §8.2 I7).
 */
const BENIGN_CODES: ReadonlySet<IngestionFindingCode> = new Set<IngestionFindingCode>([
  'EQUIVALENT_DUPLICATE_COLLAPSED',
  'LEDGER_LARGER_THAN_EXPECTED',
]);

/** Where each class lives in the package layout (design §7), for a class the expected set omits. */
const LAYOUT_FILES: Readonly<Record<ReadArtifactClass, keyof typeof UNIT_PATHS | undefined>> = {
  caller_journal: 'callerJournal',
  provider_journal: 'providerJournal',
  controller_journal: 'controllerJournal',
  runner_journal: undefined,
  ledger_snapshot: 'ledgerSnapshot',
  settlement_samples: 'settlementSamples',
  provider_trial_configuration: 'providerTrialConfiguration',
  treatment_state_snapshot: 'treatmentStateSnapshot',
};

/**
 * The state of one subject artifact of a class. The path comes from the expected artifact set;
 * when the class was not expected, the layout's path for the subject's unit is used, so a missing
 * artifact can always be named (BR-RUA-035).
 *
 * @example
 * subjectArtifactState(evidence, 'caller_journal').complete; // false when the caller journal is gapped
 */
export function subjectArtifactState(
  evidence: IngestedEvidence,
  artifactClass: ReadArtifactClass,
): SubjectArtifactState {
  const artifact = [...evidence.artifacts.values()].find(
    (candidate) => candidate.origin === 'subject' && candidate.artifact_class === artifactClass,
  );
  if (artifact === undefined) {
    return { artifact_class: artifactClass, path: expectedPath(evidence, artifactClass), complete: false };
  }
  return {
    artifact_class: artifactClass,
    path: artifact.path,
    ref: artifactRef(artifact),
    complete: artifact.parse_status === 'parsed' && !hasIncompletenessFinding(evidence.findings, artifact),
  };
}

/**
 * The reason an artifact is not complete, located at it: `ARTIFACT_MISSING` when it is absent (a
 * missing-evidence reason, BR-RUA-035), `ARTIFACT_INCOMPLETE` otherwise.
 *
 * @example
 * incompleteArtifactReason(state, 'BR-RUA-011'); // { code: 'ARTIFACT_MISSING', artifact_path: 'probe/journals/caller-journal.jsonl', ... }
 */
export function incompleteArtifactReason(state: SubjectArtifactState, subject: string): StructuredReason {
  if (state.ref === undefined) {
    return {
      code: 'ARTIFACT_MISSING',
      subject,
      artifact_path: state.path,
      detail: `${state.path} is absent; expected the ${state.artifact_class} of the evaluated subject`,
    };
  }
  return {
    code: 'ARTIFACT_INCOMPLETE',
    subject,
    artifact_path: state.path,
    detail: `${state.path} is gapped, conflicting or unreadable; expected a complete ${state.artifact_class}`,
  };
}

/**
 * The findings that touch cited evidence: a finding about one event touches a reference to that
 * event; a finding about a whole artifact touches every reference into the artifact.
 *
 * @example
 * affectingFindings(evidence.findings, [eventRef(timeoutEvent)]); // [] for clean evidence
 */
export function affectingFindings(
  findings: readonly IngestionFinding[],
  refs: readonly EvidenceRef[],
): readonly IngestionFinding[] {
  const paths = new Set(refs.map((ref) => ref.artifact_path));
  const eventIds = new Set(refs.flatMap((ref) => (ref.event_id === undefined ? [] : [ref.event_id])));
  return findings.filter((finding) => {
    if (BENIGN_CODES.has(finding.code)) {
      return false;
    }
    return finding.event_id === undefined
      ? finding.artifact_path !== undefined && paths.has(finding.artifact_path)
      : eventIds.has(finding.event_id);
  });
}

// A missing predecessor concerns the journal that should have held it, never the dependent's
// journal, so it does not make the dependent's journal incomplete.
function hasIncompletenessFinding(findings: readonly IngestionFinding[], artifact: IngestedArtifact): boolean {
  return findings.some(
    (finding) =>
      finding.artifact_path === artifact.path &&
      !BENIGN_CODES.has(finding.code) &&
      finding.code !== 'CAUSAL_PREDECESSOR_MISSING',
  );
}

function expectedPath(evidence: IngestedEvidence, artifactClass: ReadArtifactClass): string {
  const expected = evidence.expected.find((artifact) => artifact.artifact_class === artifactClass);
  if (expected !== undefined) {
    return expected.path;
  }
  const file = LAYOUT_FILES[artifactClass];
  if (file === undefined) {
    return EXECUTION_PATHS.runnerJournal;
  }
  const trial = evidence.scope.trial;
  const unit: EvidenceUnit = trial === undefined ? { kind: 'probe' } : { kind: 'trial', trial_id: trial.trial_id };
  return PACKAGE_LAYOUT.unitFile(unit, file);
}
