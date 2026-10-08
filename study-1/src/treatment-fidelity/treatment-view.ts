// The treatment view (design §8.10): the events the six conditions BR-RUA-010..015 and treatment
// fidelity read, bound once for a COMMIT_THEN_TIMEOUT trial or for the probe. The targeted attempt
// T is the attempt of the unique `provider_transaction_committed{targeted: true}` (K). The view
// binds K′ (its `provider_commit_confirmed`), Θ (T's `caller_timeout_recorded`), Σ (the
// controller's `timeout_signal_recorded`), Ω (the provider's `treatment_timeout_observed`) and Ρ
// (the provider's `treatment_response_released`), plus what fidelity needs besides them.
//
// When no unique K exists, T falls back to the treatment item's `targeted_attempt_id` and then to
// the only registered attempt, so the caller-side conditions can still be judged
// (evidence/WP-10/decisions.md).

import type {
  IndexedEvent,
  IngestedEvidence,
  IngestionFinding,
  LedgerView,
  LocatedRecord,
} from '../evidence-ingestion/ingestion-model.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import type { ProviderTrialConfiguration } from '../record-contract/records/group-a/provider_trial_configuration.ts';
import type { TreatmentStateSnapshot } from '../record-contract/records/group-b/treatment_state_snapshot.ts';
import { causedBy, eventString, eventsOfType, isCallerEvent, partitionEvents } from './subject-events.ts';
import type { EventOf } from './subject-events.ts';
import { subjectArtifactState } from './subject-artifacts.ts';
import type { SubjectArtifactState } from './subject-artifacts.ts';

/** The three journals of the evaluated trial or probe. */
export interface UnitJournals {
  readonly caller: SubjectArtifactState;
  readonly provider: SubjectArtifactState;
  readonly controller: SubjectArtifactState;
}

export interface TreatmentView {
  readonly journals: UnitJournals;
  readonly configuration_state: SubjectArtifactState;
  readonly configuration?: LocatedRecord<ProviderTrialConfiguration>;
  readonly snapshot_state: SubjectArtifactState;
  readonly snapshot?: LocatedRecord<TreatmentStateSnapshot>;
  readonly ledger_state: SubjectArtifactState;
  readonly ledger: LedgerView;
  /** Every targeted commit of the partition; K is bound only when there is exactly one. */
  readonly targeted_commits: readonly EventOf<'provider_transaction_committed'>[];
  /** K. */
  readonly commit?: EventOf<'provider_transaction_committed'>;
  /** K′: its confirmation, whose `committed_at` BR-RUA-010 compares (D-24). */
  readonly confirmation?: EventOf<'provider_commit_confirmed'>;
  /** T. */
  readonly targeted_attempt_id?: string;
  readonly dispatch?: EventOf<'dispatch_started'>;
  /** Θ, written by T's caller (the runner's canary timeout never counts). */
  readonly caller_timeout?: EventOf<'caller_timeout_recorded'>;
  readonly outcome?: EventOf<'attempt_outcome_recorded'>;
  /** Every caller event of T. */
  readonly attempt_events: readonly IndexedEvent[];
  readonly late_settlements: readonly EventOf<'transport_settled_after_timeout'>[];
  /** Σ. */
  readonly signal?: EventOf<'timeout_signal_recorded'>;
  /** Ω. */
  readonly observation?: EventOf<'treatment_timeout_observed'>;
  /** Ρ. */
  readonly release?: EventOf<'treatment_response_released'>;
  readonly safety_releases: readonly EventOf<'treatment_safety_released'>[];
  readonly conflicts: readonly EventOf<'timeout_signal_conflict_recorded'>[];
  /** Every provider commit of the partition, targeted or not. */
  readonly commits: readonly EventOf<'provider_transaction_committed'>[];
  readonly accepted_calls: readonly EventOf<'provider_call_accepted'>[];
  readonly findings: readonly IngestionFinding[];
}

/** Events of the treatment protocol that one commit owns. */
type CommitScopedType = 'timeout_signal_recorded' | 'treatment_timeout_observed' | 'treatment_response_released';

/**
 * Binds the treatment view of a COMMIT_THEN_TIMEOUT trial or of the probe. A CONTROL trial has no
 * treatment view (its scenario is judged by control integrity, G4a), and neither has a trial whose
 * scenario is unknown; both are refused with a reason.
 *
 * @example
 * const view = buildTreatmentView(ingestEvidence(input, validator));
 * if (view.ok) evaluateTreatmentConditions(view.value);
 */
export function buildTreatmentView(evidence: IngestedEvidence): Result<TreatmentView, readonly StructuredReason[]> {
  const scenarioReason = scenarioRefusal(evidence);
  if (scenarioReason !== undefined) {
    return err([scenarioReason]);
  }
  const events = partitionEvents(evidence);
  const targeted = eventsOfType(events, 'provider_transaction_committed').filter((event) => event.record.targeted);
  const commit = targeted.length === 1 ? targeted[0] : undefined;
  const snapshot = evidence.observations.treatment_snapshot;
  const attemptId = targetedAttempt(events, commit, snapshot);
  const callerEvents =
    attemptId === undefined
      ? []
      : events.filter((event) => isCallerEvent(event) && eventString(event, 'attempt_id') === attemptId);
  return ok({
    journals: {
      caller: subjectArtifactState(evidence, 'caller_journal'),
      provider: subjectArtifactState(evidence, 'provider_journal'),
      controller: subjectArtifactState(evidence, 'controller_journal'),
    },
    configuration_state: subjectArtifactState(evidence, 'provider_trial_configuration'),
    ...optional('configuration', evidence.observations.provider_configuration),
    snapshot_state: subjectArtifactState(evidence, 'treatment_state_snapshot'),
    ...optional('snapshot', snapshot),
    ledger_state: subjectArtifactState(evidence, 'ledger_snapshot'),
    ledger: evidence.ledger,
    targeted_commits: targeted,
    ...optional('commit', commit),
    ...optional('confirmation', commit === undefined ? undefined : confirmationOf(events, commit)),
    ...optional('targeted_attempt_id', attemptId),
    ...optional('dispatch', eventsOfType(callerEvents, 'dispatch_started')[0]),
    ...optional('caller_timeout', eventsOfType(callerEvents, 'caller_timeout_recorded')[0]),
    ...optional('outcome', eventsOfType(callerEvents, 'attempt_outcome_recorded')[0]),
    attempt_events: callerEvents,
    late_settlements: eventsOfType(callerEvents, 'transport_settled_after_timeout'),
    ...optional('signal', commitScoped(events, 'timeout_signal_recorded', commit, attemptId)),
    ...optional('observation', commitScoped(events, 'treatment_timeout_observed', commit, attemptId)),
    ...optional('release', commitScoped(events, 'treatment_response_released', commit, attemptId)),
    safety_releases: eventsOfType(events, 'treatment_safety_released'),
    conflicts: eventsOfType(events, 'timeout_signal_conflict_recorded'),
    commits: eventsOfType(events, 'provider_transaction_committed'),
    accepted_calls: eventsOfType(events, 'provider_call_accepted'),
    findings: evidence.findings,
  });
}

function scenarioRefusal(evidence: IngestedEvidence): StructuredReason | undefined {
  if (evidence.scope.subject_kind === 'probe') {
    return undefined;
  }
  const scenario = evidence.scope.trial?.scenario;
  if (scenario === 'COMMIT_THEN_TIMEOUT') {
    return undefined;
  }
  const detail =
    scenario === undefined
      ? 'the trial scenario is unknown (no usable trial manifest); expected COMMIT_THEN_TIMEOUT'
      : `the trial scenario is ${scenario}; expected COMMIT_THEN_TIMEOUT (a CONTROL trial is judged by control integrity)`;
  return { code: 'TREATMENT_NOT_APPLICABLE', subject: 'BR-RUA-025', detail };
}

function targetedAttempt(
  events: readonly IndexedEvent[],
  commit: EventOf<'provider_transaction_committed'> | undefined,
  snapshot: LocatedRecord<TreatmentStateSnapshot> | undefined,
): string | undefined {
  if (commit !== undefined) {
    return commit.record.attempt_id;
  }
  const item = snapshot?.record.item_present === true ? snapshot.record.treatment : undefined;
  if (item?.targeted_attempt_id !== undefined) {
    return item.targeted_attempt_id;
  }
  const registered = new Set(eventsOfType(events, 'attempt_registered').map((event) => event.record.attempt_id));
  return registered.size === 1 ? [...registered][0] : undefined;
}

// K′ names K as its cause; a confirmation that lost its causation still shares K's transaction.
function confirmationOf(
  events: readonly IndexedEvent[],
  commit: EventOf<'provider_transaction_committed'>,
): EventOf<'provider_commit_confirmed'> | undefined {
  const confirmations = eventsOfType(events, 'provider_commit_confirmed');
  return (
    confirmations.find((event) => causedBy(event, commit)) ??
    confirmations.find((event) => event.record.provider_transaction_id === commit.record.provider_transaction_id)
  );
}

// Σ, Ω and Ρ carry the commit id and T; K's commit id binds them when K exists, T otherwise.
function commitScoped<T extends CommitScopedType>(
  events: readonly IndexedEvent[],
  type: T,
  commit: EventOf<'provider_transaction_committed'> | undefined,
  attemptId: string | undefined,
): EventOf<T> | undefined {
  const candidates = eventsOfType(events, type);
  if (commit !== undefined) {
    return candidates.find((event) => event.record.provider_commit_id === commit.record.provider_commit_id);
  }
  return attemptId === undefined ? undefined : candidates.find((event) => event.record.attempt_id === attemptId);
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Readonly<Record<K, V>>> {
  return (value === undefined ? {} : { [key]: value }) as Partial<Readonly<Record<K, V>>>;
}
