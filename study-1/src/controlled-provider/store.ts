import type { PaymentRecord, PrimaryEvent } from "../protocol-records/types.ts";
import type {
  ActiveExecution,
  RefundTransaction,
  TreatmentRecord,
} from "./types.ts";

export type StoreCollection =
  | "payments"
  | "executions"
  | "ledger"
  | "journal"
  | "treatment";

export type StoreWrite = {
  collection: StoreCollection;
  key: string;
  value: unknown;
};

const COLLECTIONS: readonly StoreCollection[] = [
  "payments",
  "executions",
  "ledger",
  "journal",
  "treatment",
];

function paymentKey(trialId: string, paymentId: string): string {
  return `${trialId}\n${paymentId}`;
}

export class InMemoryProviderStore {
  readonly #data = new Map<StoreCollection, Map<string, unknown>>();
  readonly #sequences = new Map<string, number>();
  #failNext = false;

  constructor() {
    for (const name of COLLECTIONS) {
      this.#data.set(name, new Map());
    }
  }

  failNextTransact(): void {
    this.#failNext = true;
  }

  seedPayment(trialId: string, payment: PaymentRecord): void {
    this.#data.get("payments")!.set(paymentKey(trialId, payment.payment_id), payment);
  }

  seedExecution(execution: ActiveExecution): void {
    this.#data.get("executions")!.set(execution.trial_id, execution);
  }

  seedTreatment(treatment: TreatmentRecord): void {
    this.#data.get("treatment")!.set(treatment.trial_id, treatment);
  }

  getPayment(trialId: string, paymentId: string): PaymentRecord | undefined {
    return this.#data.get("payments")!.get(paymentKey(trialId, paymentId)) as
      | PaymentRecord
      | undefined;
  }

  getExecution(trialId: string): ActiveExecution | undefined {
    return this.#data.get("executions")!.get(trialId) as ActiveExecution | undefined;
  }

  getTreatment(trialId: string): TreatmentRecord | undefined {
    return this.#data.get("treatment")!.get(trialId) as TreatmentRecord | undefined;
  }

  listLedger(trialId: string): RefundTransaction[] {
    return this.#prefixed("ledger", trialId) as RefundTransaction[];
  }

  listJournal(trialId: string): PrimaryEvent[] {
    return this.#prefixed("journal", trialId) as PrimaryEvent[];
  }

  nextSequence(sourceInstanceId: string): number {
    const next = (this.#sequences.get(sourceInstanceId) ?? 0) + 1;
    this.#sequences.set(sourceInstanceId, next);
    return next;
  }

  transact(writes: readonly StoreWrite[]): boolean {
    if (this.#failNext) {
      this.#failNext = false;
      return false;
    }
    const snapshot = new Map<StoreCollection, Map<string, unknown>>();
    for (const name of COLLECTIONS) {
      snapshot.set(name, new Map(this.#data.get(name)));
    }
    for (const write of writes) {
      snapshot.get(write.collection)!.set(write.key, write.value);
    }
    for (const name of COLLECTIONS) {
      this.#data.set(name, snapshot.get(name)!);
    }
    return true;
  }

  #prefixed(collection: StoreCollection, trialId: string): unknown[] {
    const prefix = `${trialId}\n`;
    return [...this.#data.get(collection)!.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .toSorted(([left], [right]) => (left > right ? 1 : 0) - (left < right ? 1 : 0))
      .map(([, value]) => value);
  }
}
