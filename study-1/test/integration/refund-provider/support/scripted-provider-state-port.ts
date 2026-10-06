// A named fake around the real provider state port (testing rule: named fakes, not inline
// stubs). It delegates to the real port over the InMemoryItemStore emulator, counts the
// treatment reads, and lets a test script the few store outcomes a test cannot reach through
// the emulator's own fault scripting: a commit outcome derived from its plan (the plan's fresh
// identities are drawn inside the provider), a transition outcome, and another writer acting
// between the barrier's read and its write. Every scripted outcome a suite uses is one the real
// port returns for a matching store state; `fakes/scripted-provider-state-port.conformance.
// integration.test.ts` proves each against the emulator (design §12.2, RK-17).

import type { StoredItem, WriteOutcome } from '../../../../src/durable-store/item-store-port.ts';
import type { Uuid4 } from '../../../../src/record-contract/primitives.ts';
import type { TreatmentItem } from '../../../../src/record-contract/records/group-b/treatment_state_snapshot.ts';
import type { CommitPlan } from '../../../../src/refund-provider/commit-plan.ts';
import type { PaymentView, ProviderConfigView } from '../../../../src/refund-provider/control-items.ts';
import type { CallPartition } from '../../../../src/refund-provider/provider-partition.ts';
import type {
  ProviderStatePort,
  ProviderStateRead,
  TreatmentTransition,
} from '../../../../src/refund-provider/provider-state-port.ts';

/** Runs before a transition reaches the store, as another writer racing the barrier would. */
export type InterposedWriter = (transition: TreatmentTransition) => Promise<void>;

/** Answers one commit from its plan, as the store would have. */
export type CommitResponder = (plan: CommitPlan) => WriteOutcome;

/**
 * The commit outcome when the plan's ledger item already exists: the ledger put (action 0)
 * fails `attribute_not_exists` and the store returns that item (ALL_OLD).
 *
 * @example
 * harness.state.scriptCommitResponder(ledgerItemAlreadyExists);
 */
export const ledgerItemAlreadyExists: CommitResponder = (plan) => ({
  kind: 'condition_failed',
  failed_action_index: 0,
  existing: ledgerKeyOf(plan),
});

/**
 * The commit outcome when another event with `eventId` already holds the commit event's
 * journal key: the journal put (action 1) fails and the store returns the holder.
 *
 * @example
 * harness.state.scriptCommitResponder(journalKeyHeldBy(otherEventId));
 */
export function journalKeyHeldBy(eventId: Uuid4): CommitResponder {
  return (plan) => ({ kind: 'condition_failed', failed_action_index: 1, existing: journalHolderOf(plan, eventId) });
}

/**
 * The ledger item key a plan puts.
 *
 * @example
 * ledgerKeyOf(plan); // { pk: '<run>#<trial>', sk: 'tx#<provider_transaction_id>' }
 */
export function ledgerKeyOf(plan: CommitPlan): StoredItem {
  const ledgerPut = plan.actions[0];
  if (ledgerPut?.kind !== 'put' || ledgerPut.table !== 'ledger') {
    throw new Error(`commit action 0 is ${JSON.stringify(ledgerPut)}; expected the ledger put`);
  }
  return { pk: ledgerPut.item.pk, sk: ledgerPut.item.sk };
}

/**
 * The commit event's journal item as another event with `eventId` would hold its key.
 *
 * @example
 * journalHolderOf(plan, otherEventId).event_id; // otherEventId
 */
export function journalHolderOf(plan: CommitPlan, eventId: Uuid4): StoredItem {
  const journalPut = plan.actions[1];
  if (journalPut?.kind !== 'put' || journalPut.table !== 'experiment_journal') {
    throw new Error(`commit action 1 is ${JSON.stringify(journalPut)}; expected the journal put`);
  }
  return { ...journalPut.item, event_id: eventId };
}

/**
 * The provider state port with scripted outcomes; unscripted calls reach the real port.
 *
 * @example
 * const state = new ScriptedProviderStatePort(createProviderStatePort(store));
 * state.scriptCommitResponder(ledgerItemAlreadyExists);
 */
export class ScriptedProviderStatePort implements ProviderStatePort {
  readonly #inner: ProviderStatePort;
  readonly #commitResponders: CommitResponder[] = [];
  readonly #transitionOutcomes: WriteOutcome[] = [];
  readonly #interposed: InterposedWriter[] = [];
  readonly #commits: CommitPlan[] = [];
  readonly #transitions: TreatmentTransition[] = [];
  #treatmentReads = 0;

  constructor(inner: ProviderStatePort) {
    this.#inner = inner;
  }

  /** The next commit returns what `responder` derives from the plan, without reaching the store. */
  scriptCommitResponder(responder: CommitResponder): void {
    this.#commitResponders.push(responder);
  }

  /** The next transition returns `outcome` without reaching the store. */
  scriptTransitionOutcome(outcome: WriteOutcome): void {
    this.#transitionOutcomes.push(outcome);
  }

  /** The next transition first lets `writer` act on the store. */
  interposeBeforeTransition(writer: InterposedWriter): void {
    this.#interposed.push(writer);
  }

  commitsSeen(): readonly CommitPlan[] {
    return [...this.#commits];
  }

  transitionsSeen(): readonly TreatmentTransition[] {
    return [...this.#transitions];
  }

  /** How many treatment reads reached the port. */
  treatmentReadCount(): number {
    return this.#treatmentReads;
  }

  loadTrialConfiguration(partition: CallPartition): Promise<ProviderStateRead<ProviderConfigView>> {
    return this.#inner.loadTrialConfiguration(partition);
  }

  loadPayment(partition: string, paymentId: string): Promise<ProviderStateRead<PaymentView>> {
    return this.#inner.loadPayment(partition, paymentId);
  }

  loadTreatment(partition: string): Promise<ProviderStateRead<TreatmentItem>> {
    this.#treatmentReads += 1;
    return this.#inner.loadTreatment(partition);
  }

  commit(plan: CommitPlan): Promise<WriteOutcome> {
    this.#commits.push(plan);
    const responder = this.#commitResponders.shift();
    return responder === undefined ? this.#inner.commit(plan) : Promise.resolve(responder(plan));
  }

  async transition(transition: TreatmentTransition): Promise<WriteOutcome> {
    this.#transitions.push(transition);
    await this.#interposed.shift()?.(transition);
    const scripted = this.#transitionOutcomes.shift();
    return scripted ?? this.#inner.transition(transition);
  }
}
