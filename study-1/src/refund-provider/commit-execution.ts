// Executes the provider commit of one accepted call (BR-RUA-016, BR-RUA-025, D-20, D-23, D-24).
// The first accepted call of an armed COMMIT_THEN_TIMEOUT treatment commits targeted. If the
// treatment condition fails because the treatment is no longer ARMED, a new untargeted plan with
// fresh identities and a fresh token commits without consuming treatment. Any other outcome is
// final: a definitive failure records `provider_commit_failed` and faults; an ambiguous outcome
// stops the source instance and faults. After the transaction is acknowledged the provider
// records `provider_commit_confirmed` with the post-acknowledgement wall time `committed_at`,
// which BR-RUA-010 compares with the caller timer.

import type { WriteOutcome } from '../durable-store/item-store-port.ts';
import type { JournalWriter } from '../event-journal/journal-writer.ts';
import type { MonotonicClock, Uuid4, UuidSource, WallClock } from '../record-contract/primitives.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { AcceptedCall } from './acceptance.ts';
import type { CommitKind, CommitPlan } from './commit-plan.ts';
import { COMMIT_JOURNAL_ACTION_INDEX, commitEventBody, drawCommitIdentities, planCommit } from './commit-plan.ts';
import { ProviderFault } from './provider-fault.ts';
import type { ProviderStatePort } from './provider-state-port.ts';
import { describeWriteOutcome } from './untrusted-json.ts';

export interface CommitExecutionDeps {
  readonly state: ProviderStatePort;
  readonly journal: JournalWriter;
  readonly ids: UuidSource;
  readonly wall: WallClock;
  readonly monotonic: MonotonicClock;
}

export interface CommitRequest {
  readonly partition: string;
  readonly call: AcceptedCall;
  readonly provider_call_id: Uuid4;
  /** `provider_call_accepted`, the commit event's causal predecessor. */
  readonly accepted_event_id: Uuid4;
  readonly kind: CommitKind;
}

/** A durably committed plan and the moment its acknowledgement arrived. */
export interface ConfirmedCommit {
  readonly plan: CommitPlan;
  readonly commit_ack_ns: bigint;
  readonly confirmed_event_id: Uuid4;
}

interface CommittedPlan {
  readonly plan: CommitPlan;
  readonly ack_ns: bigint;
  readonly ack_wall: Date;
}

/**
 * Commits an accepted call and records the confirmation. Throws a ProviderFault when nothing
 * was committed, when the outcome is unknown, or when the confirmation cannot be recorded.
 *
 * @example
 * const confirmed = await executeCommit(deps, { partition, call, provider_call_id, accepted_event_id, kind: 'targeted' });
 * if (confirmed.plan.kind === 'targeted') await barrier.awaitRelease(...);
 */
export async function executeCommit(deps: CommitExecutionDeps, request: CommitRequest): Promise<ConfirmedCommit> {
  const attempt = await attemptCommit(deps, request, request.kind);
  const ids = attempt.plan.ids;
  const confirmed = await deps.journal.append(
    'provider_commit_confirmed',
    {
      provider_commit_id: ids.provider_commit_id,
      provider_transaction_id: ids.provider_transaction_id,
      provider_call_id: request.provider_call_id,
      committed_at: formatUtcMillis(attempt.ack_wall),
    },
    [ids.commit_event_id],
  );
  if (confirmed.kind === 'stopped') {
    throw new ProviderFault(
      'JOURNAL_STOPPED',
      'after_commit',
      request.provider_call_id,
      `provider_commit_confirmed not recorded (${confirmed.reason}); expected a writable source instance`,
    );
  }
  return { plan: attempt.plan, commit_ack_ns: attempt.ack_ns, confirmed_event_id: confirmed.event.event_id };
}

async function attemptCommit(
  deps: CommitExecutionDeps,
  request: CommitRequest,
  kind: CommitKind,
): Promise<CommittedPlan> {
  const identities = drawCommitIdentities(deps.ids);
  const requestedAt = formatUtcMillis(deps.wall.now());
  const body = commitEventBody(request.call, request.provider_call_id, identities, kind === 'targeted', requestedAt);
  const prepared = deps.journal.prepare('provider_transaction_committed', body, [request.accepted_event_id]);
  if (prepared.kind === 'stopped') {
    throw new ProviderFault(
      'JOURNAL_STOPPED',
      'before_commit',
      request.provider_call_id,
      `provider_transaction_committed not prepared (${prepared.reason}); expected a writable source instance`,
    );
  }
  const plan = planCommit({
    kind,
    partition: request.partition,
    call: request.call,
    provider_call_id: request.provider_call_id,
    identities,
    commit_requested_at: requestedAt,
    commit_event: prepared.put,
  });
  const outcome = await deps.state.commit(plan);
  const ackNs = deps.monotonic.nowNs();
  const ackWall = deps.wall.now();
  const confirmed = deps.journal.confirm(prepared.put, outcome, COMMIT_JOURNAL_ACTION_INDEX);
  if (confirmed.kind === 'appended') {
    return { plan, ack_ns: ackNs, ack_wall: ackWall };
  }
  if (confirmed.kind === 'stopped') {
    const code = confirmed.reason === 'AMBIGUOUS_APPEND' ? 'COMMIT_AMBIGUOUS' : 'JOURNAL_STOPPED';
    throw new ProviderFault(
      code,
      'commit_unknown',
      request.provider_call_id,
      `commit ${plan.ids.provider_commit_id} outcome ${describeWriteOutcome(outcome)} stopped the instance (${confirmed.reason}); expected applied or definitively not applied`,
    );
  }
  if (outcome.kind === 'condition_failed' && outcome.failed_action_index === plan.treatment_action_index) {
    // The treatment is no longer ARMED: commit untargeted with fresh identities and token. An
    // untargeted plan has no treatment action, so this re-plan happens at most once.
    return attemptCommit(deps, request, 'untargeted');
  }
  return recordCommitFailure(deps, request, plan, outcome);
}

async function recordCommitFailure(
  deps: CommitExecutionDeps,
  request: CommitRequest,
  plan: CommitPlan,
  outcome: WriteOutcome,
): Promise<never> {
  const errorCode = outcome.kind === 'definitive_failure' ? outcome.code : 'TransactionConditionFailed';
  const detail = `commit ${plan.ids.provider_commit_id} not applied: ${describeWriteOutcome(outcome)}; expected applied`;
  const failed = await deps.journal.append(
    'provider_commit_failed',
    {
      provider_commit_id: plan.ids.provider_commit_id,
      provider_transaction_id: plan.ids.provider_transaction_id,
      provider_call_id: request.provider_call_id,
      targeted: plan.kind === 'targeted',
      error_code: errorCode,
      detail,
    },
    [request.accepted_event_id],
  );
  if (failed.kind === 'stopped') {
    throw new ProviderFault(
      'JOURNAL_STOPPED',
      'before_commit',
      request.provider_call_id,
      `provider_commit_failed not recorded (${failed.reason}); ${detail}`,
    );
  }
  throw new ProviderFault('COMMIT_FAILED', 'before_commit', request.provider_call_id, detail);
}
