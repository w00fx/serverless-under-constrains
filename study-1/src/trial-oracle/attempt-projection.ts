// The derived attempt projection of one trial (design §8.9, BR-RUA-037): one entry per attempt in
// order, every received provider call in the order received (rejected ones included), every
// ledger transaction by reference, and every Durable execution the metadata lists (AC-RUA-003).
// It explains a verdict and is never fed back into one. The transaction an attempt produced is joined through the
// provider's commit event, never through the caller's claim.

import { foldEffectKnowledge } from '../attempt-lifecycle/effect-knowledge.ts';
import type { IndexedEvent, IngestedEvidence } from '../evidence-ingestion/ingestion-model.ts';
import type { ExecutionIdentityFields } from '../record-contract/envelope.ts';
import type { Sha256Hex, Uuid4, UtcMillis } from '../record-contract/primitives.ts';
import type {
  AttemptProjection,
  ProjectedAttempt,
  ProjectedInvocation,
  ProjectedProviderCall,
  ProjectedTransaction,
} from '../record-contract/records/group-c/attempt_projection.ts';
import { eventsOfType, isCallerEvent, partitionEvents } from '../treatment-fidelity/subject-events.ts';
import type { EventOf } from '../treatment-fidelity/subject-events.ts';
import { compareOccurrence } from './attempt-facts.ts';
import type { AttemptFacts } from './attempt-facts.ts';

/** Who the projection belongs to: the execution and the trial. */
export interface ProjectionIdentity {
  readonly execution: ExecutionIdentityFields;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly trial_id: Uuid4;
  readonly trial_manifest_sha256: Sha256Hex;
}

/**
 * Builds the attempt projection of a trial from its evidence and attempts.
 *
 * @example
 * buildAttemptProjection(evidence, readAttempts(evidence), identity, checkedAt).attempts.length; // 2
 */
export function buildAttemptProjection(
  evidence: IngestedEvidence,
  attempts: readonly AttemptFacts[],
  identity: ProjectionIdentity,
  derivedAt: UtcMillis,
): AttemptProjection {
  const events = partitionEvents(evidence);
  return {
    schema_version: 1,
    record_type: 'attempt_projection',
    ...identity.execution,
    execution_manifest_sha256: identity.execution_manifest_sha256,
    trial_id: identity.trial_id,
    trial_manifest_sha256: identity.trial_manifest_sha256,
    attempts: attempts.map((attempt, index) => projectedAttempt(events, attempts.slice(0, index + 1), attempt)),
    provider_calls: eventsOfType(events, 'provider_call_received')
      .toSorted(compareOccurrence)
      .map((received) => providerCall(events, received)),
    transactions: projectedTransactions(evidence),
    durable_executions: (evidence.observations.durable_executions?.record.executions ?? []).map((execution) => ({
      durable_execution_arn: execution.durable_execution_arn,
      status: execution.status,
    })),
    derived_at: derivedAt,
  };
}

function projectedAttempt(
  events: readonly IndexedEvent[],
  upToHere: readonly AttemptFacts[],
  attempt: AttemptFacts,
): ProjectedAttempt {
  const registered = attempt.registered.record;
  const attemptId = registered.attempt_id;
  // An outcome that contradicts its dispatch evidence is not trusted (the rules count the attempt
  // ambiguous), so the projection lists the attempt without it, as one whose outcome is unknown.
  const outcome = attempt.contradiction === undefined ? attempt.outcome?.record : undefined;
  const commit = eventsOfType(events, 'provider_transaction_committed').find(
    (event) => event.record.attempt_id === attemptId,
  );
  const callId = outcome?.provider_call_id ?? acceptedCallOf(events, attemptId);
  const late = eventsOfType(events, 'transport_settled_after_timeout').find(
    (event) => event.record.attempt_id === attemptId,
  );
  const recorded = recordedKnowledge(events, attemptId);
  return {
    attempt_id: attemptId,
    provider_request_id: registered.provider_request_id,
    refund_request_id: registered.refund_request_id,
    registered_event_id: registered.event_id,
    invocation: invocationOf(attempt),
    dispatch_state: attempt.dispatch_state,
    ...(outcome === undefined ? {} : { outcome: outcome.outcome }),
    outcome_class: attempt.outcome_class,
    ...(callId === undefined ? {} : { provider_call_id: callId }),
    ...(commit === undefined ? {} : { provider_transaction_id: commit.record.provider_transaction_id }),
    ...(late === undefined
      ? {}
      : {
          late_transport_settlement: {
            settlement_kind: late.record.settlement_kind,
            observed_after_elapsed_ns: late.record.observed_after_elapsed_ns,
          },
        }),
    knowledge_after_derived: foldEffectKnowledge(upToHere.map((earlier) => earlier.outcome_class)),
    ...(recorded === undefined ? {} : { knowledge_after_recorded: recorded }),
  };
}

/**
 * The invocation an attempt ran in; its source instance is the attempt's own when no
 * `caller_invocation_started` was recorded. Only a Durable invocation carries an execution ARN,
 * and a probe invocation carries no message.
 *
 * @example
 * invocationOf(attempt).receive_count; // 2 for a conventional redelivery
 */
export function invocationOf(attempt: AttemptFacts): ProjectedInvocation {
  const head = {
    source: attempt.registered.record.source,
    source_instance_id: attempt.registered.record.source_instance_id,
  };
  const started = attempt.invocation?.record;
  if (started === undefined || started.source === 'probe_caller') {
    return head;
  }
  const counts = { message_id: started.message_id, receive_count: started.approximate_receive_count };
  if (started.source === 'conventional_caller') {
    return { ...head, ...counts };
  }
  return {
    ...head,
    ...counts,
    durable_execution_arn: started.durable_execution_arn,
    ...(started.step_attempt === undefined ? {} : { step_attempt: started.step_attempt }),
  };
}

function acceptedCallOf(events: readonly IndexedEvent[], attemptId: string): Uuid4 | undefined {
  return eventsOfType(events, 'provider_call_accepted').find((event) => event.record.attempt_id === attemptId)?.record
    .provider_call_id;
}

// The knowledge the caller recorded right after this attempt: the last request state whose
// attempt list ends with it.
function recordedKnowledge(
  events: readonly IndexedEvent[],
  attemptId: string,
): ProjectedAttempt['knowledge_after_recorded'] {
  return eventsOfType(events, 'request_state_recorded')
    .filter(isCallerEvent)
    .filter((state) => state.record.attempt_ids.at(-1) === attemptId)
    .toSorted((a, b) => a.record.version - b.record.version)
    .at(-1)?.record.effect_knowledge;
}

function providerCall(
  events: readonly IndexedEvent[],
  received: EventOf<'provider_call_received'>,
): ProjectedProviderCall {
  const callId = received.record.provider_call_id;
  const head = { provider_call_id: callId, received_event_id: received.record.event_id };
  const accepted = eventsOfType(events, 'provider_call_accepted').find(
    (event) => event.record.provider_call_id === callId,
  );
  if (accepted !== undefined) {
    return {
      ...head,
      disposition: 'ACCEPTED',
      attempt_id: accepted.record.attempt_id,
      provider_request_id: accepted.record.provider_request_id,
    };
  }
  const rejected = eventsOfType(events, 'provider_call_rejected').find(
    (event) => event.record.provider_call_id === callId,
  );
  return rejected === undefined
    ? { ...head, disposition: 'UNRESOLVED' }
    : { ...head, disposition: 'REJECTED', rejection_reason: rejected.record.reason };
}

function projectedTransactions(evidence: IngestedEvidence): readonly ProjectedTransaction[] {
  const snapshot = evidence.ledger.snapshot;
  if (snapshot === undefined) {
    return [];
  }
  return snapshot.record.transactions.map((transaction, index) => ({
    provider_transaction_id: transaction.provider_transaction_id,
    provider_commit_id: transaction.provider_commit_id,
    provider_call_id: transaction.provider_call_id,
    ledger_ref: {
      artifact_path: snapshot.artifact_path,
      artifact_sha256: snapshot.artifact_sha256,
      json_pointer: `/transactions/${String(index)}`,
    },
  }));
}
