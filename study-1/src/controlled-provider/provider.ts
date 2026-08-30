import { randomUUID } from "node:crypto";
import { createPrimaryEvent } from "../protocol-records/event-records.ts";
import {
  fail,
  isPositiveSafeInteger,
  isRecord,
  isSha256Hex,
  isUuidV4,
} from "../protocol-records/primitives.ts";
import type { PaymentRecord, PrimaryEvent, ValidationResult } from "../protocol-records/types.ts";
import { AUTHORIZATION } from "./infrastructure.ts";
import { bindingKeyOf, createRefundCall } from "./refund-call.ts";
import type { InMemoryProviderStore, StoreWrite } from "./store.ts";
import type {
  ActiveExecution,
  DeniedRead,
  ExecutionBindingKey,
  LedgerPage,
  Principal,
  ProcessRefundResult,
  ProviderIds,
  ProviderOperation,
  RefundCall,
  RefundTransaction,
  ReleasePort,
  TreatmentRead,
  TreatmentRecord,
} from "./types.ts";

const BINDING_KEYS: readonly ExecutionBindingKey[] = [
  "run_id",
  "transport_probe_id",
  "variant_validation_id",
];

function isPrincipal(value: unknown): value is Principal {
  return value === "variant" || value === "independent";
}

export function authorize(
  principal: unknown,
  operation: ProviderOperation,
): ValidationResult<Principal> {
  if (!isPrincipal(principal)) {
    return fail(["unauthenticated"]);
  }
  if (!AUTHORIZATION[principal].allow.includes(operation)) {
    return fail(["unauthorized"]);
  }
  return { ok: true, value: principal };
}

const DEFAULT_SOURCE_INSTANCE_ID = randomUUID();

function defaultIds(): ProviderIds {
  return {
    provider_call_id: randomUUID(),
    provider_transaction_id: randomUUID(),
    provider_commit_id: randomUUID(),
    event_id: randomUUID(),
    source_instance_id: DEFAULT_SOURCE_INSTANCE_ID,
  };
}

function defaultNow(): string {
  return new Date().toISOString();
}

function defaultRelease(): void {}

function executionMatches(call: RefundCall, active: ActiveExecution): boolean {
  if (active.trial_id !== call.trial_id) {
    return false;
  }
  if (active.trial_manifest_sha256 !== call.trial_manifest_sha256) {
    return false;
  }
  const key = bindingKeyOf(call);
  return active[key] === call[key];
}

function readExecutionMatches(
  trialId: string,
  execution: Record<string, unknown>,
  active: ActiveExecution | undefined,
): boolean {
  if (active === undefined || active.trial_id !== trialId) {
    return false;
  }
  if (
    !isSha256Hex(execution.trial_manifest_sha256) ||
    active.trial_manifest_sha256 !== execution.trial_manifest_sha256
  ) {
    return false;
  }
  const bindings = BINDING_KEYS.filter((key) => execution[key] !== undefined);
  if (bindings.length !== 1) {
    return false;
  }
  const key = bindings[0]!;
  return isUuidV4(execution[key]) && active[key] === execution[key];
}

function copyBinding(from: RefundCall, to: RefundTransaction): RefundTransaction {
  const key = bindingKeyOf(from);
  to[key] = from[key];
  return to;
}

function journalEvent(
  recordType: "provider_call_rejected" | "provider_committed",
  call: RefundCall,
  ids: ProviderIds,
  occurredAt: string,
  sequence: number,
  extra: Record<string, unknown>,
): PrimaryEvent | undefined {
  const key = bindingKeyOf(call);
  const created = createPrimaryEvent({
    schema_version: 1,
    record_type: recordType,
    event_id: ids.event_id,
    occurred_at: occurredAt,
    source: "controlled_provider",
    source_instance_id: ids.source_instance_id,
    source_sequence: sequence,
    trial_manifest_sha256: call.trial_manifest_sha256,
    trial_id: call.trial_id,
    attempt_id: call.attempt_id,
    provider_request_id: call.provider_request_id,
    provider_call_id: ids.provider_call_id,
    payment_id: call.payment_id,
    refund_request_id: call.refund_request_id,
    ...extra,
    [key]: call[key],
  });
  return created.ok ? created.value : undefined;
}

function reject(
  store: InMemoryProviderStore,
  call: RefundCall | undefined,
  ids: ProviderIds,
  occurredAt: string,
  reasons: readonly string[],
): ProcessRefundResult {
  if (call === undefined) {
    return { outcome: "rejected", provider_call_id: ids.provider_call_id, reasons };
  }
  const sequence = store.peekSequence(ids.source_instance_id);
  const event = journalEvent(
    "provider_call_rejected",
    call,
    ids,
    occurredAt,
    sequence,
    { reasons },
  );
  if (event === undefined) {
    return { outcome: "rejected", provider_call_id: ids.provider_call_id, reasons };
  }
  const persisted = store.transact(
    [{ collection: "journal", key: `${call.trial_id}\n${event.event_id}`, value: event }],
    { source_instance_id: ids.source_instance_id, source_sequence: sequence },
  );
  if (!persisted) {
    return { outcome: "failed", provider_call_id: ids.provider_call_id, reasons: ["transact_failed"] };
  }
  return { outcome: "rejected", provider_call_id: ids.provider_call_id, reasons, event };
}

function currentTreatment(store: InMemoryProviderStore, trialId: string): TreatmentRecord {
  return (
    store.getTreatment(trialId) ?? {
      schema_version: 1,
      record_type: "treatment_state",
      trial_id: trialId,
      state: "UNARMED",
    }
  );
}

function consumeTreatment(
  existing: TreatmentRecord,
  call: RefundCall,
  ids: ProviderIds,
  scenario: ActiveExecution["scenario"],
): TreatmentRecord {
  if (scenario !== "COMMIT_THEN_TIMEOUT" || existing.state !== "ARMED") {
    return existing;
  }
  return {
    schema_version: 1,
    record_type: "treatment_state",
    trial_id: call.trial_id,
    state: "COMMITTED_WAITING",
    provider_commit_id: ids.provider_commit_id,
    attempt_id: call.attempt_id,
    provider_request_id: call.provider_request_id,
    provider_call_id: ids.provider_call_id,
    provider_transaction_id: ids.provider_transaction_id,
  };
}

export function processRefundCall(
  store: InMemoryProviderStore,
  input: {
    principal: unknown;
    call: unknown;
    now?: string;
    ids?: ProviderIds;
    release?: ReleasePort;
  },
): ProcessRefundResult {
  const ids = input.ids ?? defaultIds();
  const occurredAt = input.now ?? defaultNow();
  const release = input.release ?? defaultRelease;
  const allowed = authorize(input.principal, "refund");
  if (!allowed.ok) {
    return reject(store, undefined, ids, occurredAt, allowed.reasons);
  }
  const parsed = createRefundCall(input.call);
  if (!parsed.ok) {
    return reject(store, undefined, ids, occurredAt, parsed.reasons);
  }
  const call = parsed.value;
  const active = store.getExecution(call.trial_id);
  if (active === undefined || !executionMatches(call, active)) {
    return reject(store, call, ids, occurredAt, ["inactive_execution"]);
  }
  const payment = store.getPayment(call.trial_id, call.payment_id);
  if (payment === undefined) {
    return reject(store, call, ids, occurredAt, ["payment_not_found"]);
  }
  if (call.currency !== payment.currency) {
    return reject(store, call, ids, occurredAt, ["currency_mismatch"]);
  }
  return commitAccepted(store, call, payment, active, ids, occurredAt, release);
}

function commitAccepted(
  store: InMemoryProviderStore,
  call: RefundCall,
  payment: PaymentRecord,
  active: ActiveExecution,
  ids: ProviderIds,
  occurredAt: string,
  release: ReleasePort,
): ProcessRefundResult {
  const transaction = copyBinding(call, {
    schema_version: 1,
    record_type: "refund_transaction",
    provider_transaction_id: ids.provider_transaction_id,
    provider_call_id: ids.provider_call_id,
    provider_commit_id: ids.provider_commit_id,
    trial_id: call.trial_id,
    trial_manifest_sha256: call.trial_manifest_sha256,
    attempt_id: call.attempt_id,
    provider_request_id: call.provider_request_id,
    payment_id: payment.payment_id,
    refund_request_id: call.refund_request_id,
    amount_minor: call.amount_minor,
    currency: call.currency,
    status: "SUCCEEDED",
    committed_at: occurredAt,
  });
  const sequence = store.peekSequence(ids.source_instance_id);
  const event = journalEvent(
    "provider_committed",
    call,
    ids,
    occurredAt,
    sequence,
    {
      provider_transaction_id: ids.provider_transaction_id,
      provider_commit_id: ids.provider_commit_id,
      amount_minor: call.amount_minor,
      currency: call.currency,
    },
  );
  if (event === undefined) {
    return { outcome: "failed", provider_call_id: ids.provider_call_id, reasons: ["invalid_event"] };
  }
  const existingTreatment = currentTreatment(store, call.trial_id);
  const treatment = consumeTreatment(existingTreatment, call, ids, active.scenario);
  const consumesTreatment = treatment.state !== existingTreatment.state;
  const writes: StoreWrite[] = [
    {
      collection: "ledger",
      key: `${call.trial_id}\n${transaction.provider_transaction_id}`,
      value: transaction,
    },
    { collection: "journal", key: `${call.trial_id}\n${event.event_id}`, value: event },
  ];
  if (consumesTreatment) {
    writes.push({ collection: "treatment", key: call.trial_id, value: treatment });
  }
  const committed = store.transact(writes, {
    source_instance_id: ids.source_instance_id,
    source_sequence: sequence,
  });
  if (!committed) {
    return { outcome: "failed", provider_call_id: ids.provider_call_id, reasons: ["transact_failed"] };
  }
  // Only the targeted call holds the treatment barrier, so only its commit may
  // release. A CONTROL accept and every later untargeted accept just return.
  if (consumesTreatment) {
    release({ provider_commit_id: ids.provider_commit_id, treatment });
  }
  return {
    outcome: "accepted",
    provider_call_id: ids.provider_call_id,
    transaction,
    event,
    treatment,
  };
}

function readGuard(
  store: InMemoryProviderStore,
  principal: unknown,
  operation: ProviderOperation,
  trialId: unknown,
  execution: unknown,
): DeniedRead | { ok: true; trialId: string } {
  const allowed = authorize(principal, operation);
  if (!allowed.ok) {
    return { ok: false, reasons: allowed.reasons };
  }
  if (!isUuidV4(trialId) || !isRecord(execution)) {
    return { ok: false, reasons: ["inactive_execution"] };
  }
  if (!readExecutionMatches(trialId, execution, store.getExecution(trialId))) {
    return { ok: false, reasons: ["inactive_execution"] };
  }
  return { ok: true, trialId };
}

export function readLedger(
  store: InMemoryProviderStore,
  input: {
    principal: unknown;
    trial_id: unknown;
    execution: unknown;
    cursor?: unknown;
    limit?: unknown;
  },
): LedgerPage | DeniedRead {
  const guard = readGuard(store, input.principal, "read_ledger", input.trial_id, input.execution);
  if (!guard.ok) {
    return guard;
  }
  const limit = input.limit === undefined ? 100 : input.limit;
  if (!isPositiveSafeInteger(limit)) {
    return { ok: false, reasons: ["invalid_page_limit"] };
  }
  const all = store.listLedger(guard.trialId);
  let start = 0;
  if (input.cursor !== undefined) {
    // No non-string can equal a transaction id, so the lookup is the only
    // validation a cursor needs: an unmatched cursor of any type is invalid.
    const index = all.findIndex((row) => row.provider_transaction_id === input.cursor);
    if (index < 0) {
      return { ok: false, reasons: ["invalid_cursor"] };
    }
    start = index + 1;
  }
  const transactions = all.slice(start, start + limit);
  const exhausted = start + limit >= all.length;
  const page: LedgerPage = { ok: true, complete: exhausted, transactions };
  if (!exhausted) {
    page.next_cursor = transactions[transactions.length - 1]!.provider_transaction_id;
  }
  return page;
}

export function readTreatmentState(
  store: InMemoryProviderStore,
  input: { principal: unknown; trial_id: unknown; execution: unknown },
): TreatmentRead | DeniedRead {
  const guard = readGuard(
    store,
    input.principal,
    "read_treatment_state",
    input.trial_id,
    input.execution,
  );
  if (!guard.ok) {
    return guard;
  }
  return { ok: true, treatment: currentTreatment(store, guard.trialId) };
}
