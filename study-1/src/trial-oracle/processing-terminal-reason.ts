// The trial's `processing_terminal_reason` (design §8.7, D-17) from three sources:
//   (a) the runner's `trial_interrupted`: LEASE_LOST, OPERATOR_ABORT and INTERRUPTED give
//       INTERRUPTED, SAFETY_DEADLINE gives SAFETY_DEADLINE;
//   (b) the DLQ snapshot holds the trial message (by SQS message id or body digest):
//       RETRIES_EXHAUSTED, authoritative terminal evidence (RK-08);
//   (c) the last FINISHED `request_state_recorded` supplies its own reason.
// (c) with (b) must agree on RETRIES_EXHAUSTED; (c) alone may claim RETRIES_EXHAUSTED only when its
// deciding invocation received the message for the last time (BR-RUA-024, max_receive_count 2 of
// OR-RUA-002); FINISHED states that disagree with each other are a conflict. A null reason makes
// G6 unverified.

import { eventRef, reasonAt } from '../evidence-ingestion/gate-assessment.ts';
import type { IndexedEvent, IngestedEvidence } from '../evidence-ingestion/ingestion-model.ts';
import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import type { StructuredReason } from '../record-contract/primitives.ts';
import type {
  ConventionalInvocationStarted,
  DurableInvocationStarted,
} from '../record-contract/records/group-b/caller_invocation_started.ts';
import type {
  FinishedRequestState,
  MessageRejectedRequestState,
} from '../record-contract/records/group-b/request_state_recorded.ts';
import type { InterruptionCause, ProcessingTerminalReason } from '../record-contract/records/group-b/vocabulary.ts';
import { incompleteArtifactReason, subjectArtifactState } from '../treatment-fidelity/subject-artifacts.ts';
import { eventsOfType, isCallerEvent, partitionEvents } from '../treatment-fidelity/subject-events.ts';
import type { EventOf } from '../treatment-fidelity/subject-events.ts';

/** OR-RUA-002: the source queue's redrive threshold, the last receive before the DLQ. */
export const MAX_RECEIVE_COUNT = 2;

const SUBJECT = 'BR-RUA-030';

const INTERRUPTION_REASONS: Readonly<Record<InterruptionCause, ProcessingTerminalReason>> = {
  LEASE_LOST: 'INTERRUPTED',
  OPERATOR_ABORT: 'INTERRUPTED',
  INTERRUPTED: 'INTERRUPTED',
  SAFETY_DEADLINE: 'SAFETY_DEADLINE',
};

export interface TerminalReasonDerivation {
  readonly reason: ProcessingTerminalReason | null;
  /** Why the reason is null; empty when it is derived. */
  readonly reasons: readonly StructuredReason[];
  /** The events and snapshot the reason rests on. */
  readonly evidence_refs: readonly EvidenceRef[];
}

type QueueInvocation = EventOf<'caller_invocation_started'> & {
  readonly record: ConventionalInvocationStarted | DurableInvocationStarted;
};

type FinishedState = EventOf<'request_state_recorded'> & {
  readonly record: FinishedRequestState | MessageRejectedRequestState;
};

/**
 * Derives the trial's processing terminal reason, or null with the reason it cannot be.
 *
 * @example
 * deriveProcessingTerminalReason(evidence).reason; // 'SUCCEEDED' for a completed control trial
 */
export function deriveProcessingTerminalReason(evidence: IngestedEvidence): TerminalReasonDerivation {
  const events = partitionEvents(evidence);
  const finished = eventsOfType(events, 'request_state_recorded')
    .filter(isCallerEvent)
    .filter((event): event is FinishedState => event.record.processing_state === 'FINISHED')
    .toSorted((a, b) => a.record.version - b.record.version);
  const dlqRef = dlqMessageRef(evidence, events);
  const last = finished.at(-1);
  if (last !== undefined) {
    return fromFinishedState(events, finished, last, dlqRef);
  }
  if (dlqRef !== undefined) {
    return { reason: 'RETRIES_EXHAUSTED', reasons: [], evidence_refs: [dlqRef] };
  }
  const interrupted = eventsOfType(events, 'trial_interrupted').at(-1);
  if (interrupted !== undefined) {
    return {
      reason: INTERRUPTION_REASONS[interrupted.record.cause],
      reasons: [],
      evidence_refs: [eventRef(interrupted)],
    };
  }
  return unknownTerminal(evidence);
}

function fromFinishedState(
  events: readonly IndexedEvent[],
  finished: readonly FinishedState[],
  last: FinishedState,
  dlqRef: EvidenceRef | undefined,
): TerminalReasonDerivation {
  const claimed = last.record.processing_terminal_reason;
  const refs = [eventRef(last), ...(dlqRef === undefined ? [] : [dlqRef])];
  const disagreeing = finished.find((state) => state.record.processing_terminal_reason !== claimed);
  if (disagreeing !== undefined) {
    const detail = `FINISHED states ${disagreeing.record.event_id} (${disagreeing.record.processing_terminal_reason}) and ${last.record.event_id} (${claimed}) disagree; expected one terminal reason`;
    return conflict(detail, last, [...refs, eventRef(disagreeing)]);
  }
  if (dlqRef !== undefined) {
    return claimed === 'RETRIES_EXHAUSTED'
      ? { reason: claimed, reasons: [], evidence_refs: refs }
      : conflict(
          `the DLQ holds the trial message but the request state finished ${claimed}; expected RETRIES_EXHAUSTED`,
          last,
          refs,
        );
  }
  if (claimed !== 'RETRIES_EXHAUSTED') {
    return { reason: claimed, reasons: [], evidence_refs: refs };
  }
  const invocation = decidingInvocation(events, last);
  const receiveCount = invocation?.record.approximate_receive_count;
  if (invocation !== undefined && receiveCount !== undefined && receiveCount >= MAX_RECEIVE_COUNT) {
    return { reason: claimed, reasons: [], evidence_refs: [...refs, eventRef(invocation)] };
  }
  const detail = `RETRIES_EXHAUSTED was recorded by an invocation with receive count ${String(receiveCount ?? '(unknown)')}; expected the last receive (${String(MAX_RECEIVE_COUNT)}) before the request finishes`;
  return {
    reason: null,
    reasons: [reasonAt('BR-RUA-024', 'TERMINALITY_BEFORE_LAST_LAYER', detail, eventRef(last))],
    evidence_refs: invocation === undefined ? refs : [...refs, eventRef(invocation)],
  };
}

function conflict(detail: string, at: FinishedState, refs: readonly EvidenceRef[]): TerminalReasonDerivation {
  return {
    reason: null,
    reasons: [reasonAt(SUBJECT, 'PROCESSING_TERMINAL_CONFLICT', detail, eventRef(at))],
    evidence_refs: refs,
  };
}

// The queue-driven caller invocation that wrote the FINISHED state: the one started in the same
// source instance. A probe invocation receives no message, so it never decides a receive count.
function decidingInvocation(events: readonly IndexedEvent[], state: FinishedState): QueueInvocation | undefined {
  return eventsOfType(events, 'caller_invocation_started').find(
    (invocation): invocation is QueueInvocation =>
      invocation.record.source !== 'probe_caller' &&
      invocation.record.source === state.record.source &&
      invocation.record.source_instance_id === state.record.source_instance_id,
  );
}

// (b): the DLQ snapshot holds the published trial message, by SQS message id or body digest.
function dlqMessageRef(evidence: IngestedEvidence, events: readonly IndexedEvent[]): EvidenceRef | undefined {
  const snapshot = evidence.observations.dlq_snapshot;
  const published = eventsOfType(events, 'trial_message_published').at(-1)?.record;
  if (snapshot === undefined || published === undefined) {
    return undefined;
  }
  const index = snapshot.record.messages.findIndex(
    (message) => message.message_id === published.message_id || message.body_sha256 === published.message_body_sha256,
  );
  return index < 0
    ? undefined
    : {
        artifact_path: snapshot.artifact_path,
        artifact_sha256: snapshot.artifact_sha256,
        json_pointer: `/messages/${String(index)}`,
      };
}

// No source decides: processing was still active, or the evidence that would decide is absent.
function unknownTerminal(evidence: IngestedEvidence): TerminalReasonDerivation {
  const caller = subjectArtifactState(evidence, 'caller_journal');
  if (caller.ref === undefined) {
    return { reason: null, reasons: [incompleteArtifactReason(caller, SUBJECT)], evidence_refs: [] };
  }
  const detail =
    'no FINISHED request state, DLQ capture of the trial message or trial interruption is recorded; expected a terminal processing state';
  return {
    reason: null,
    reasons: [reasonAt(SUBJECT, 'PROCESSING_NOT_TERMINAL', detail, caller.ref)],
    evidence_refs: [caller.ref],
  };
}
