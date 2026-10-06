// The targeted call's treatment barrier (BR-RUA-025, BR-RUA-012..014, OR-RUA-002). After the
// targeted commit is acknowledged the provider keeps executing while the caller times out
// (BR-RUA-012): it polls the treatment item every 250 ms with consistent reads, observes the
// controller signal (`TIMEOUT_SIGNALLED -> TIMEOUT_OBSERVED`, caused by the signal event),
// and releases immediately (`TIMEOUT_OBSERVED -> RESPONSE_RELEASED`, caused by the
// observation). With no signal 15 s after the commit it safety-releases. Each transition is
// conditional on its from-state and carries its provider event in the same transaction; a
// failed condition means another writer moved the state, so the barrier reads again. An
// ambiguous transition stops the source instance and ends the call with a fault (D-20).

import { elapsedNs } from '../record-contract/decimal.ts';
import type { MonotonicClock, Sleeper, Uuid4, UuidSource } from '../record-contract/primitives.ts';
import type { SafetyReleaseCause, TreatmentState } from '../record-contract/records/group-b/vocabulary.ts';
import type { WriteOutcome } from '../durable-store/item-store-port.ts';
import type { EventBody } from '../event-journal/journal-event.ts';
import type { JournalWriter } from '../event-journal/journal-writer.ts';
import type { EventRecordType } from '../record-contract/record-types.ts';
import type { BarrierStep, CommittedWaitState } from './barrier-decision.ts';
import { decideBarrierStep, isCommittedWaitState } from './barrier-decision.ts';
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

type TransitionResult = 'applied' | 'read_again' | 'wait_and_read_again';

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
    for (;;) {
      const read = await this.#deps.state.loadTreatment(commit.partition);
      const treatment = read.ok ? read.value : undefined;
      this.#waitState = latestWaitState(treatment?.state, this.#waitState);
      const elapsed = this.#deps.monotonic.nowNs() - commit.commit_ack_ns;
      const step = decideBarrierStep(treatment, commit.provider_commit_id, elapsed, safetyReleaseNs);
      const outcome = await this.#perform(step, commit);
      if (outcome !== undefined) {
        return outcome;
      }
    }
  }

  async #perform(step: BarrierStep, commit: BarrierCommit): Promise<BarrierOutcome | undefined> {
    switch (step.kind) {
      case 'keep_waiting':
        await this.#deps.sleeper.sleep(this.#deps.pollIntervalMs);
        return undefined;
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

  async #observe(commit: BarrierCommit, signalEventId: Uuid4): Promise<BarrierOutcome | undefined> {
    const body = { ...commitRefs(commit), signal_event_id: signalEventId };
    const observed = await this.#transition(commit, 'TIMEOUT_SIGNALLED', 'TIMEOUT_OBSERVED', 'observed_event_id', {
      type: 'treatment_timeout_observed',
      body,
      causation: [signalEventId],
    });
    if (observed.result !== 'applied') {
      return this.#readAgain(observed.result);
    }
    // Release immediately after the observation, without another read (BR-RUA-025).
    return this.#release(commit, observed.event_id);
  }

  async #release(commit: BarrierCommit, observedEventId: Uuid4): Promise<BarrierOutcome | undefined> {
    const released = await this.#transition(commit, 'TIMEOUT_OBSERVED', 'RESPONSE_RELEASED', 'release_event_id', {
      type: 'treatment_response_released',
      body: commitRefs(commit),
      causation: [observedEventId],
    });
    return released.result === 'applied' ? { kind: 'released' } : this.#readAgain(released.result);
  }

  async #safetyRelease(commit: BarrierCommit, from: CommittedWaitState): Promise<BarrierOutcome | undefined> {
    const released = await this.#transition(commit, from, 'SAFETY_RELEASED', undefined, {
      type: 'treatment_safety_released',
      body: this.#safetyReleaseBody(commit, 'SAFETY_DEADLINE', from),
      causation: [commit.commit_event_id],
    });
    return released.result === 'applied' ? { kind: 'safety_released' } : this.#readAgain(released.result);
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
  ): Promise<{ readonly result: TransitionResult; readonly event_id: Uuid4 }> {
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
      return { result: 'applied', event_id: eventId };
    }
    return { result: notAppliedResult(commit, from, to, outcome), event_id: eventId };
  }

  async #readAgain(result: Exclude<TransitionResult, 'applied'>): Promise<undefined> {
    if (result === 'wait_and_read_again') {
      await this.#deps.sleeper.sleep(this.#deps.pollIntervalMs);
    }
    return undefined;
  }
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

// A failed condition with the item present means another writer moved the state: read again
// at once. A failed condition without an item means the treatment item vanished, which no
// writer may cause. A definitive failure changed nothing: wait one poll, then try again.
function notAppliedResult(
  commit: BarrierCommit,
  from: CommittedWaitState,
  to: string,
  outcome: WriteOutcome,
): Exclude<TransitionResult, 'applied'> {
  if (outcome.kind !== 'condition_failed') {
    return 'wait_and_read_again';
  }
  if (outcome.existing === undefined) {
    throw new ProviderFault(
      'TREATMENT_UNEXPECTED',
      'after_commit',
      commit.provider_call_id,
      `${from} -> ${to} found no treatment item; expected the item of commit ${commit.provider_commit_id}`,
    );
  }
  return 'read_again';
}

function stoppedFault(commit: BarrierCommit, detail: string): ProviderFault {
  return new ProviderFault(
    'JOURNAL_STOPPED',
    'after_commit',
    commit.provider_call_id,
    `${detail}; expected a writable source instance`,
  );
}
