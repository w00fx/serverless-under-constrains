// The targeted call's treatment barrier (BR-RUA-025, BR-RUA-012..014, OR-RUA-002). After the
// targeted commit is acknowledged the provider keeps executing while the caller times out
// (BR-RUA-012): it polls the treatment item every 250 ms with consistent reads, observes the
// controller signal (`TIMEOUT_SIGNALLED -> TIMEOUT_OBSERVED`, caused by the signal event),
// and releases immediately (`TIMEOUT_OBSERVED -> RESPONSE_RELEASED`, caused by the
// observation). With no signal 15 s after the commit it safety-releases. Each transition is
// conditional on its from-state and carries its provider event in the same transaction; a
// failed condition means another writer moved the state, and the item image the store returns
// with the failure (ALL_OLD) is the state the barrier decides from next, without another read.
// Every other turn that writes nothing waits one poll interval, so neither a failing read nor a
// failing write can spin the loop (WP-07 review round 1: failing reads after the deadline
// re-issued the safety release with no wait). An ambiguous transition stops the source instance
// and ends the call with a fault (D-20).

import { elapsedNs } from '../record-contract/decimal.ts';
import type { MonotonicClock, Sleeper, Uuid4, UuidSource } from '../record-contract/primitives.ts';
import type { SafetyReleaseCause, TreatmentState } from '../record-contract/records/group-b/vocabulary.ts';
import type { WriteOutcome } from '../durable-store/item-store-port.ts';
import type { EventBody } from '../event-journal/journal-event.ts';
import type { JournalWriter } from '../event-journal/journal-writer.ts';
import type { EventRecordType } from '../record-contract/record-types.ts';
import type { TreatmentItem } from '../record-contract/records/group-b/treatment_state_snapshot.ts';
import type { BarrierStep, CommittedWaitState } from './barrier-decision.ts';
import { decideBarrierStep, isCommittedWaitState } from './barrier-decision.ts';
import { decodeTreatmentItem } from './control-items.ts';
import { ProviderFault } from './provider-fault.ts';
import type { ProviderStatePort } from './provider-state-port.ts';

export { BARRIER_TIMING } from './barrier-timing.ts';

const NS_PER_MS = 1_000_000n;

/** The targeted commit whose response waits at the barrier. */
export interface BarrierCommit {
  readonly partition: string;
  readonly provider_commit_id: Uuid4;
  readonly provider_call_id: Uuid4;
  readonly attempt_id: Uuid4;
  /** The in-transaction `provider_transaction_committed` event. */
  readonly commit_event_id: Uuid4;
  /** Monotonic reading taken when the commit was acknowledged. */
  readonly commit_ack_ns: bigint;
}

export type BarrierOutcome =
  | { readonly kind: 'released' }
  | { readonly kind: 'safety_released' }
  | { readonly kind: 'externally_released'; readonly cause: SafetyReleaseCause };

export interface TreatmentBarrierDeps {
  readonly state: ProviderStatePort;
  readonly journal: JournalWriter;
  readonly monotonic: MonotonicClock;
  readonly sleeper: Sleeper;
  /** Fresh ClientRequestTokens for the transitions. */
  readonly ids: UuidSource;
  readonly pollIntervalMs: number;
  readonly safetyReleaseMs: number;
}

/** How a transition ended: applied, superseded by another writer (with the item as it is now), or not applied. */
type TransitionResult =
  | { readonly kind: 'applied'; readonly event_id: Uuid4 }
  | { readonly kind: 'superseded'; readonly current: TreatmentItem }
  | { readonly kind: 'not_applied' };

/** What the loop does after a step that did not end the wait: read again, or decide from a known image. */
type NextRead = { readonly kind: 'read' } | { readonly kind: 'decide'; readonly treatment: TreatmentItem };

const READ_NEXT: NextRead = { kind: 'read' };

/**
 * The targeted call's wait at the treatment barrier: it polls the treatment item, observes and
 * releases the controller signal, or safety-releases at the deadline. One instance serves one
 * commit.
 *
 * @example
 * const barrier = new TreatmentBarrier({ state, journal, monotonic, sleeper, ids, pollIntervalMs: 250, safetyReleaseMs: 15_000 });
 * const outcome = await barrier.awaitRelease(commit); // { kind: 'released' }
 */
export class TreatmentBarrier {
  readonly #deps: TreatmentBarrierDeps;
  /** The last wait state this barrier read or wrote; an external release records it. */
  #waitState: CommittedWaitState = 'COMMITTED_WAITING';

  constructor(deps: TreatmentBarrierDeps) {
    this.#deps = deps;
  }

  /**
   * Holds the targeted response until it is released, safety-released, or released by another
   * writer. Throws a ProviderFault when the wait cannot be settled or recorded.
   *
   * @example
   * const outcome = await barrier.awaitRelease({ partition, provider_commit_id, provider_call_id, attempt_id, commit_event_id, commit_ack_ns });
   */
  async awaitRelease(commit: BarrierCommit): Promise<BarrierOutcome> {
    const safetyReleaseNs = BigInt(this.#deps.safetyReleaseMs) * NS_PER_MS;
    this.#waitState = 'COMMITTED_WAITING';
    let next: NextRead = READ_NEXT;
    for (;;) {
      const treatment = next.kind === 'decide' ? next.treatment : await this.#readTreatment(commit.partition);
      this.#waitState = latestWaitState(treatment?.state, this.#waitState);
      const elapsed = this.#deps.monotonic.nowNs() - commit.commit_ack_ns;
      const step = decideBarrierStep(treatment, commit.provider_commit_id, elapsed, safetyReleaseNs);
      const performed = await this.#perform(step, commit);
      if (!isNextRead(performed)) {
        return performed;
      }
      next = performed;
    }
  }

  // A failed or undecodable read is no news (decideBarrierStep documents why); the conditional
  // safety release at the deadline settles what the state really is.
  async #readTreatment(partition: string): Promise<TreatmentItem | undefined> {
    const read = await this.#deps.state.loadTreatment(partition);
    return read.ok ? read.value : undefined;
  }

  async #perform(step: BarrierStep, commit: BarrierCommit): Promise<BarrierOutcome | NextRead> {
    switch (step.kind) {
      case 'keep_waiting':
        return this.#waitOnePoll();
      case 'observe':
        return this.#observe(commit, step.signal_event_id);
      case 'release':
        return this.#release(commit, step.observed_event_id);
      case 'safety_release':
        return this.#safetyRelease(commit, step.from_state);
      case 'externally_released':
        return this.#recordExternalRelease(commit, step.cause);
      case 'unexpected_state':
        throw new ProviderFault('TREATMENT_UNEXPECTED', 'after_commit', commit.provider_call_id, step.detail);
    }
  }

  async #observe(commit: BarrierCommit, signalEventId: Uuid4): Promise<BarrierOutcome | NextRead> {
    const body = { ...commitRefs(commit), signal_event_id: signalEventId };
    const observed = await this.#transition(commit, 'TIMEOUT_SIGNALLED', 'TIMEOUT_OBSERVED', 'observed_event_id', {
      type: 'treatment_timeout_observed',
      body,
      causation: [signalEventId],
    });
    if (observed.kind !== 'applied') {
      return this.#continueAfter(observed);
    }
    // Release immediately after the observation, without another read (BR-RUA-025).
    return this.#release(commit, observed.event_id);
  }

  async #release(commit: BarrierCommit, observedEventId: Uuid4): Promise<BarrierOutcome | NextRead> {
    const released = await this.#transition(commit, 'TIMEOUT_OBSERVED', 'RESPONSE_RELEASED', 'release_event_id', {
      type: 'treatment_response_released',
      body: commitRefs(commit),
      causation: [observedEventId],
    });
    return released.kind === 'applied' ? { kind: 'released' } : this.#continueAfter(released);
  }

  async #safetyRelease(commit: BarrierCommit, from: CommittedWaitState): Promise<BarrierOutcome | NextRead> {
    const released = await this.#transition(commit, from, 'SAFETY_RELEASED', undefined, {
      type: 'treatment_safety_released',
      body: this.#safetyReleaseBody(commit, 'SAFETY_DEADLINE', from),
      causation: [commit.commit_event_id],
    });
    return released.kind === 'applied' ? { kind: 'safety_released' } : this.#continueAfter(released);
  }

  async #recordExternalRelease(commit: BarrierCommit, cause: SafetyReleaseCause): Promise<BarrierOutcome> {
    // The state already moved; the provider records that its own wait ended, from the last
    // wait state it read or wrote, so the accepted call has a terminal provider event (§9.3).
    const body = this.#safetyReleaseBody(commit, cause, this.#waitState);
    const appended = await this.#deps.journal.append('treatment_safety_released', body, [commit.commit_event_id]);
    if (appended.kind === 'stopped') {
      throw stoppedFault(commit, `treatment_safety_released not recorded (${appended.reason})`);
    }
    return { kind: 'externally_released', cause };
  }

  #safetyReleaseBody(
    commit: BarrierCommit,
    cause: SafetyReleaseCause,
    from: CommittedWaitState,
  ): EventBody<'treatment_safety_released'> {
    const elapsed = elapsedNs(commit.commit_ack_ns, this.#deps.monotonic.nowNs());
    return { cause, from_state: from, ...commitRefs(commit), elapsed_since_commit_ns: elapsed };
  }

  async #transition<T extends TransitionEventType>(
    commit: BarrierCommit,
    from: CommittedWaitState,
    to: 'TIMEOUT_OBSERVED' | 'RESPONSE_RELEASED' | 'SAFETY_RELEASED',
    eventIdAttribute: 'observed_event_id' | 'release_event_id' | undefined,
    event: TransitionEvent<T>,
  ): Promise<TransitionResult> {
    const prepared = this.#deps.journal.prepare(event.type, event.body, event.causation);
    if (prepared.kind === 'stopped') {
      throw stoppedFault(commit, `${event.type} not prepared (${prepared.reason})`);
    }
    const eventId = prepared.put.event.event_id;
    const set = to === 'SAFETY_RELEASED' ? { safety_release_cause: 'SAFETY_DEADLINE' } : {};
    const outcome = await this.#deps.state.transition({
      partition: commit.partition,
      from,
      to,
      set: eventIdAttribute === undefined ? set : { ...set, [eventIdAttribute]: eventId },
      event: prepared.put,
      token: this.#deps.ids.next(),
    });
    const confirmed = this.#deps.journal.confirm(prepared.put, outcome);
    if (confirmed.kind === 'stopped') {
      throw new ProviderFault(
        'TRANSITION_AMBIGUOUS',
        'after_commit',
        commit.provider_call_id,
        `${from} -> ${to} outcome ${JSON.stringify(outcome)}; expected applied or definitively not applied`,
      );
    }
    if (confirmed.kind === 'appended') {
      this.#waitState = latestWaitState(to, this.#waitState);
      return { kind: 'applied', event_id: eventId };
    }
    return notAppliedResult(commit, from, to, outcome);
  }

  // A superseded transition decides at once from the item the failed condition returned; a
  // transition that changed nothing waits one poll first.
  async #continueAfter(result: Exclude<TransitionResult, { readonly kind: 'applied' }>): Promise<NextRead> {
    return result.kind === 'superseded' ? { kind: 'decide', treatment: result.current } : this.#waitOnePoll();
  }

  async #waitOnePoll(): Promise<NextRead> {
    await this.#deps.sleeper.sleep(this.#deps.pollIntervalMs);
    return READ_NEXT;
  }
}

function isNextRead(value: BarrierOutcome | NextRead): value is NextRead {
  return value.kind === 'read' || value.kind === 'decide';
}

type TransitionEventType = 'treatment_timeout_observed' | 'treatment_response_released' | 'treatment_safety_released';

interface TransitionEvent<T extends EventRecordType> {
  readonly type: T;
  readonly body: EventBody<T>;
  readonly causation: readonly Uuid4[];
}

function commitRefs(commit: BarrierCommit): {
  readonly provider_commit_id: Uuid4;
  readonly provider_call_id: Uuid4;
  readonly attempt_id: Uuid4;
} {
  return {
    provider_commit_id: commit.provider_commit_id,
    provider_call_id: commit.provider_call_id,
    attempt_id: commit.attempt_id,
  };
}

function latestWaitState(state: TreatmentState | undefined, previous: CommittedWaitState): CommittedWaitState {
  return isCommittedWaitState(state) ? state : previous;
}

// A failed condition with the item present means another writer moved the state; the item
// as the store found it (ALL_OLD) is the state to decide from. The writer's journal confirm has
// already classified a collision on the journal put, so a failed condition reaching here is the
// treatment update's (action 0). A failed condition without an item means the treatment item
// vanished, which no writer may cause; an image the provider cannot decode leaves it nothing to
// decide from. A definitive failure changed nothing.
function notAppliedResult(
  commit: BarrierCommit,
  from: CommittedWaitState,
  to: string,
  outcome: WriteOutcome,
): Exclude<TransitionResult, { readonly kind: 'applied' }> {
  if (outcome.kind !== 'condition_failed') {
    return { kind: 'not_applied' };
  }
  if (outcome.existing === undefined) {
    throw new ProviderFault(
      'TREATMENT_UNEXPECTED',
      'after_commit',
      commit.provider_call_id,
      `${from} -> ${to} found no treatment item; expected the item of commit ${commit.provider_commit_id}`,
    );
  }
  const current = decodeTreatmentItem(outcome.existing);
  if (!current.ok) {
    throw new ProviderFault(
      'STATE_UNREADABLE',
      'after_commit',
      commit.provider_call_id,
      `${from} -> ${to} was superseded by an undecodable treatment item (${current.error}); expected a decodable wait state`,
    );
  }
  return { kind: 'superseded', current: current.value };
}

function stoppedFault(commit: BarrierCommit, detail: string): ProviderFault {
  return new ProviderFault(
    'JOURNAL_STOPPED',
    'after_commit',
    commit.provider_call_id,
    `${detail}; expected a writable source instance`,
  );
}
