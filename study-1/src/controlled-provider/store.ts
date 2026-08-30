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

export type SequenceCommit = {
  source_instance_id: string;
  source_sequence: number;
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

  // Peeking leaves the counter untouched so an append that never lands cannot
  // burn a sequence: `source_sequence` must stay dense per source instance, and
  // a retry of a definitively failed append has to reuse the same value.
  peekSequence(sourceInstanceId: string): number {
    return (this.#sequences.get(sourceInstanceId) ?? 0) + 1;
  }

  transact(writes: readonly StoreWrite[], sequence?: SequenceCommit): boolean {
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
    if (sequence !== undefined) {
      this.#sequences.set(sequence.source_instance_id, sequence.source_sequence);
    }
    return true;
  }

  // Sorting the keys rather than the entries keeps the order on the default
  // UTF-16 code-unit comparison, which is the collation the partition/sort key
  // pair already encodes.
  #prefixed(collection: StoreCollection, trialId: string): unknown[] {
    const prefix = `${trialId}\n`;
    const rows = this.#data.get(collection)!;
    return [...rows.keys()]
      .filter((key) => key.startsWith(prefix))
      .toSorted()
      .map((key) => rows.get(key));
  }
}
