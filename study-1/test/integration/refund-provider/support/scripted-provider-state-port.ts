// A named fake around the real provider state port (testing rule: named fakes, not inline
// stubs). It delegates to the real port over the InMemoryItemStore emulator and lets a test
// script what the emulator cannot produce on its own: a chosen commit or transition outcome,
// a chosen treatment read, or another writer acting between the barrier's read and its write.

import type { WriteOutcome } from '../../../../src/durable-store/item-store-port.ts';
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

export class ScriptedProviderStatePort implements ProviderStatePort {
  readonly #inner: ProviderStatePort;
  readonly #commitResponders: CommitResponder[] = [];
  readonly #transitionOutcomes: WriteOutcome[] = [];
  readonly #treatmentReads: ProviderStateRead<TreatmentItem>[] = [];
  readonly #interposed: InterposedWriter[] = [];
  readonly #commits: CommitPlan[] = [];
  readonly #transitions: TreatmentTransition[] = [];

  constructor(inner: ProviderStatePort) {
    this.#inner = inner;
  }

  /** The next commit returns `outcome` without reaching the store. */
  scriptCommitOutcome(outcome: WriteOutcome): void {
    this.#commitResponders.push(() => outcome);
  }

  /** The next commit returns what `responder` derives from the plan, without reaching the store. */
  scriptCommitResponder(responder: CommitResponder): void {
    this.#commitResponders.push(responder);
  }

  /** The next transition returns `outcome` without reaching the store. */
  scriptTransitionOutcome(outcome: WriteOutcome): void {
    this.#transitionOutcomes.push(outcome);
  }

  /** The next treatment read returns `read` without reaching the store. */
  scriptTreatmentRead(read: ProviderStateRead<TreatmentItem>): void {
    this.#treatmentReads.push(read);
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

  loadTrialConfiguration(partition: CallPartition): Promise<ProviderStateRead<ProviderConfigView>> {
    return this.#inner.loadTrialConfiguration(partition);
  }

  loadPayment(partition: string, paymentId: string): Promise<ProviderStateRead<PaymentView>> {
    return this.#inner.loadPayment(partition, paymentId);
  }

  loadTreatment(partition: string): Promise<ProviderStateRead<TreatmentItem>> {
    const scripted = this.#treatmentReads.shift();
    return scripted === undefined ? this.#inner.loadTreatment(partition) : Promise.resolve(scripted);
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
