// The journal record of each controller decision (design §9.11 "Write" column, catalogue group B
// rows 39-44). Every record answering a valid caller event is caused by that event; a record
// about an invalid event is a causal root, because an event that failed validation is not a
// trustworthy predecessor. The signal's record is written inside the treatment transaction, so
// it is prepared here and appended by the transaction (BR-RUA-025 "one transaction").

import type { AppendResult, PrepareResult } from '../event-journal/journal-append-port.ts';
import type { JournalWriter } from '../event-journal/journal-writer.ts';
import type { SignalDecision } from './signal-decision.ts';

/** A decision answered by an ordinary append (every decision except the signal). */
export type AppendedDecision = Exclude<SignalDecision, { readonly kind: 'signal' }>;
export type SignalOnlyDecision = Extract<SignalDecision, { readonly kind: 'signal' }>;

/**
 * Reserves the `timeout_signal_recorded` put that the signal transaction carries.
 *
 * @example
 * const prepared = prepareSignalRecord(journal, decision);
 * if (prepared.kind === 'prepared') await state.signal({ ..., event: prepared.put });
 */
export function prepareSignalRecord(journal: JournalWriter, decision: SignalOnlyDecision): PrepareResult {
  return journal.prepare(
    'timeout_signal_recorded',
    {
      provider_commit_id: decision.provider_commit_id,
      attempt_id: decision.attempt_id,
      caller_timeout_event_id: decision.caller_timeout_event_id,
      provider_commit_event_id: decision.commit_event_id,
    },
    decision.causation,
  );
}

/**
 * Appends the record of a decision that changes no state.
 *
 * @example
 * await appendDecisionRecord(journal, { kind: 'late_rejected', caller_timeout_event_id, attempt_id });
 * // appends late_timeout_signal_rejected{treatment_state: 'SAFETY_RELEASED'}, caused by the caller event
 */
export function appendDecisionRecord(journal: JournalWriter, decision: AppendedDecision): Promise<AppendResult> {
  if (decision.kind === 'canary_acknowledged') {
    return journal.append('controller_canary_acknowledged', { canary_event_id: decision.canary_event_id }, [
      decision.canary_event_id,
    ]);
  }
  if (decision.kind === 'invalid_event_rejected') {
    return journal.append('caller_timeout_rejected', {
      reason: 'INVALID_EVENT',
      detail: decision.detail,
      ...(decision.caller_timeout_event_id === undefined
        ? {}
        : { caller_timeout_event_id: decision.caller_timeout_event_id }),
      ...(decision.attempt_id === undefined ? {} : { attempt_id: decision.attempt_id }),
      ...(decision.treatment_state === undefined ? {} : { treatment_state: decision.treatment_state }),
    });
  }
  return appendCallerAnswer(journal, decision);
}

function appendCallerAnswer(
  journal: JournalWriter,
  decision: Exclude<AppendedDecision, { readonly kind: 'canary_acknowledged' | 'invalid_event_rejected' }>,
): Promise<AppendResult> {
  const refs = { caller_timeout_event_id: decision.caller_timeout_event_id, attempt_id: decision.attempt_id };
  const causation = [decision.caller_timeout_event_id];
  switch (decision.kind) {
    case 'control_trial_rejected':
      return journal.append(
        'caller_timeout_rejected',
        { reason: 'CONTROL_TRIAL', detail: decision.detail, ...refs },
        causation,
      );
    case 'before_commit_rejected':
      return journal.append(
        'caller_timeout_rejected',
        { reason: 'BEFORE_COMMIT', detail: decision.detail, ...refs, treatment_state: 'ARMED' },
        causation,
      );
    case 'not_targeted_rejected':
      return journal.append(
        'caller_timeout_rejected',
        { reason: 'NOT_TARGETED', detail: decision.detail, ...refs, treatment_state: 'COMMITTED_WAITING' },
        causation,
      );
    case 'late_rejected':
      return journal.append('late_timeout_signal_rejected', { ...refs, treatment_state: 'SAFETY_RELEASED' }, causation);
    case 'duplicate_ignored':
      return journal.append(
        'timeout_signal_duplicate_observed',
        { ...refs, treatment_state: decision.treatment_state },
        causation,
      );
    case 'conflict':
      return journal.append(
        'timeout_signal_conflict_recorded',
        {
          ...refs,
          existing_caller_event_id: decision.existing_caller_event_id,
          treatment_state: decision.treatment_state,
        },
        causation,
      );
  }
}
