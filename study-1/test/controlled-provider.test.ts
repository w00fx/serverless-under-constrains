import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRefundCall,
  InMemoryProviderStore,
  processRefundCall,
  readLedger,
  readTreatmentState,
} from "../src/controlled-provider/index.ts";
import { classifyEventSequence, createPayment } from "../src/protocol-records/index.ts";
import type { ValidationResult } from "../src/protocol-records/types.ts";
import type { ActiveExecution, ProviderIds } from "../src/controlled-provider/types.ts";

const DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const TRIAL = "66666666-6666-4666-8666-666666666666";
const RUN = "33333333-3333-4333-8333-333333333333";
const PROBE = "44444444-4444-4444-8444-444444444444";
const VALIDATION = "55555555-5555-4555-8555-555555555555";
const ATTEMPT = "11111111-1111-4111-8111-111111111111";
const REQUEST = "77777777-7777-4777-8777-777777777777";
const NOW = "2026-08-30T12:00:00.000Z";

const IDS: ProviderIds = {
  provider_call_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  provider_transaction_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  provider_commit_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  event_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  source_instance_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
};

function idsFor(index: number): ProviderIds {
  const suffix = String(index);
  const uuid = (char: string): string =>
    `${char.repeat(8)}-${char.repeat(4)}-4${char.repeat(3)}-8${char.repeat(3)}-${char.repeat(11)}${suffix}`;
  return {
    provider_call_id: uuid("a"),
    provider_transaction_id: uuid("b"),
    provider_commit_id: uuid("c"),
    event_id: uuid("d"),
    source_instance_id: IDS.source_instance_id,
  };
}

function payment() {
  const created = createPayment({
    schema_version: 1,
    record_type: "payment",
    payment_id: "pay-poc-001",
    captured_amount_minor: 10000,
    currency: "BRL",
  });
  assert.equal(created.ok, true);
  if (!created.ok) {
    throw new Error("payment");
  }
  return created.value;
}

function call(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    record_type: "refund_call",
    run_id: RUN,
    trial_id: TRIAL,
    trial_manifest_sha256: DIGEST,
    attempt_id: ATTEMPT,
    provider_request_id: REQUEST,
    payment_id: "pay-poc-001",
    refund_request_id: "ref-poc-001",
    amount_minor: 10000,
    currency: "BRL",
    ...overrides,
  };
}

function execution(overrides: Partial<ActiveExecution> = {}): ActiveExecution {
  return {
    trial_id: TRIAL,
    trial_manifest_sha256: DIGEST,
    scenario: "CONTROL",
    run_id: RUN,
    ...overrides,
  };
}

function seed(scenario: ActiveExecution["scenario"] = "CONTROL"): InMemoryProviderStore {
  const store = new InMemoryProviderStore();
  store.seedPayment(TRIAL, payment());
  store.seedExecution(execution({ scenario }));
  if (scenario === "COMMIT_THEN_TIMEOUT") {
    store.seedTreatment({
      schema_version: 1,
      record_type: "treatment_state",
      trial_id: TRIAL,
      state: "ARMED",
    });
  }
  return store;
}

function process(
  store: InMemoryProviderStore,
  raw: unknown = call(),
  extra: { principal?: unknown; now?: string; ids?: ProviderIds } = {},
) {
  return processRefundCall(store, {
    principal: extra.principal ?? "variant",
    call: raw,
    now: extra.now ?? NOW,
    ids: extra.ids ?? IDS,
  });
}

function assertRejected(result: ValidationResult<unknown>, ...expected: string[]): void {
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.deepEqual([...result.reasons].toSorted(), [...expected].toSorted());
}

describe("refund call records", () => {
  it("accepts a valid call and trims identities", () => {
    const created = createRefundCall(call({ payment_id: "  pay-poc-001  " }));
    assert.equal(created.ok, true);
    if (created.ok) {
      assert.equal(created.value.payment_id, "pay-poc-001");
      assert.equal(created.value.run_id, RUN);
    }
  });

  it("rejects invalid refund-call values with exact reasons", () => {
    assertRejected(createRefundCall(null), "not_an_object");
    assertRejected(createRefundCall(call({ schema_version: 2 })), "invalid_schema_version");
    assertRejected(createRefundCall(call({ record_type: "payment" })), "invalid_record_type");
    assertRejected(createRefundCall(call({ run_id: undefined })), "missing_execution_binding");
    assertRejected(
      createRefundCall(call({ transport_probe_id: PROBE })),
      "ambiguous_execution_binding",
    );
    assertRejected(createRefundCall(call({ run_id: "not-uuid" })), "invalid_uuid");
    assertRejected(createRefundCall(call({ trial_id: "not-uuid" })), "invalid_uuid");
    assertRejected(createRefundCall(call({ trial_manifest_sha256: "zz" })), "invalid_sha256");
    assertRejected(createRefundCall(call({ attempt_id: "not-uuid" })), "invalid_uuid");
    assertRejected(createRefundCall(call({ provider_request_id: "not-uuid" })), "invalid_uuid");
    assertRejected(createRefundCall(call({ payment_id: "" })), "empty_identity");
    assertRejected(createRefundCall(call({ payment_id: 1 })), "invalid_identifier");
    assertRejected(createRefundCall(call({ refund_request_id: "   " })), "empty_identity");
    assertRejected(createRefundCall(call({ refund_request_id: 1 })), "invalid_identifier");
    assertRejected(createRefundCall(call({ amount_minor: 0 })), "invalid_amount");
    assertRejected(createRefundCall(call({ currency: "USD" })), "invalid_currency");
    assertRejected(createRefundCall(call({ extra: true })), "unknown_property");
    assertRejected(createRefundCall(call({ evidence: [] })), "alias_rejected");
  });
});

describe("controlled provider contract", () => {
  it("accepts a CONTROL call without a treatment transition", () => {
    const store = seed("CONTROL");
    const result = process(store);
    assert.equal(result.outcome, "accepted");
    if (result.outcome !== "accepted") {
      return;
    }
    assert.equal(result.transaction.status, "SUCCEEDED");
    assert.equal(result.transaction.provider_commit_id, IDS.provider_commit_id);
    assert.equal(result.event.record_type, "provider_committed");
    assert.equal(result.event.provider_commit_id, IDS.provider_commit_id);
    assert.equal(result.treatment.state, "UNARMED");
    assert.equal(store.getTreatment(TRIAL), undefined);
    assert.equal(store.listLedger(TRIAL).length, 1);
  });

  it("accepts a structurally valid wrong-effect call", () => {
    const store = seed();
    const result = process(
      store,
      call({ amount_minor: 1, refund_request_id: "ref-other" }),
    );
    assert.equal(result.outcome, "accepted");
    if (result.outcome !== "accepted") {
      return;
    }
    assert.equal(result.transaction.amount_minor, 1);
    assert.equal(result.transaction.refund_request_id, "ref-other");
  });

  it("does not suppress a second accepted effect", () => {
    const store = seed("COMMIT_THEN_TIMEOUT");
    const first = process(store);
    const second = process(store, call(), { ids: idsFor(1) });
    assert.equal(first.outcome, "accepted");
    assert.equal(second.outcome, "accepted");
    assert.equal(store.listLedger(TRIAL).length, 2);
    if (first.outcome === "accepted") {
      assert.equal(first.treatment.state, "COMMITTED_WAITING");
      assert.equal(store.getTreatment(TRIAL)?.provider_commit_id, first.treatment.provider_commit_id);
    }
    if (second.outcome === "accepted") {
      assert.equal(second.treatment.state, "COMMITTED_WAITING");
      assert.equal(second.treatment.provider_commit_id, first.outcome === "accepted"
        ? first.treatment.provider_commit_id
        : undefined);
    }
  });

  it("atomically consumes treatment on the first CTT accept", () => {
    const store = seed("COMMIT_THEN_TIMEOUT");
    let released = 0;
    const result = processRefundCall(store, {
      principal: "independent",
      call: call(),
      now: NOW,
      ids: IDS,
      release: () => {
        released += 1;
      },
    });
    assert.equal(result.outcome, "accepted");
    assert.equal(released, 1);
    if (result.outcome !== "accepted") {
      return;
    }
    assert.equal(result.treatment.state, "COMMITTED_WAITING");
    assert.equal(result.treatment.provider_commit_id, IDS.provider_commit_id);
    assert.equal(result.treatment.provider_transaction_id, IDS.provider_transaction_id);
    assert.equal(store.getTreatment(TRIAL)?.provider_call_id, IDS.provider_call_id);
  });

  it("does not release a barrier for a CONTROL accept", () => {
    const store = seed("CONTROL");
    let released = 0;
    const result = processRefundCall(store, {
      principal: "variant",
      call: call(),
      now: NOW,
      ids: IDS,
      release: () => {
        released += 1;
      },
    });
    assert.equal(result.outcome, "accepted");
    assert.equal(released, 0);
  });

  it("releases only for the accept that consumes treatment", () => {
    const store = seed("COMMIT_THEN_TIMEOUT");
    const released: string[] = [];
    const release = (context: { provider_commit_id: string }): void => {
      released.push(context.provider_commit_id);
    };
    const first = processRefundCall(store, {
      principal: "variant",
      call: call(),
      now: NOW,
      ids: idsFor(0),
      release,
    });
    const second = processRefundCall(store, {
      principal: "variant",
      call: call(),
      now: NOW,
      ids: idsFor(1),
      release,
    });
    assert.equal(first.outcome, "accepted");
    assert.equal(second.outcome, "accepted");
    assert.equal(store.listLedger(TRIAL).length, 2);
    assert.deepEqual(released, [idsFor(0).provider_commit_id]);
  });

  it("keeps journal sequences dense when an append does not land", () => {
    const store = seed();
    assert.equal(process(store, call(), { ids: idsFor(0) }).outcome, "accepted");
    store.failNextTransact();
    assert.equal(process(store, call(), { ids: idsFor(1) }).outcome, "failed");
    store.failNextTransact();
    assert.equal(
      process(store, call({ payment_id: "missing" }), { ids: idsFor(2) }).outcome,
      "failed",
    );
    assert.equal(process(store, call(), { ids: idsFor(3) }).outcome, "accepted");
    const journal = store.listJournal(TRIAL);
    assert.deepEqual(
      journal.map((event) => event.source_sequence).toSorted(),
      [1, 2],
    );
    const report = classifyEventSequence(journal);
    assert.equal(report.ok, true);
    if (report.ok) {
      assert.deepEqual(report.value.gaps, []);
    }
  });

  it("records rejected calls without a transaction or treatment consume", () => {
    const store = seed("COMMIT_THEN_TIMEOUT");
    const result = process(store, call({ payment_id: "missing" }));
    assert.equal(result.outcome, "rejected");
    if (result.outcome !== "rejected") {
      return;
    }
    assert.deepEqual([...result.reasons], ["payment_not_found"]);
    assert.equal(result.event?.record_type, "provider_call_rejected");
    assert.equal(store.listLedger(TRIAL).length, 0);
    assert.equal(store.getTreatment(TRIAL)?.state, "ARMED");
  });

  it("rejects inactive execution, currency mismatch, and unauthenticated calls", () => {
    const store = seed();
    const inactive = process(store, call({ trial_manifest_sha256: "a".repeat(64) }));
    assert.equal(inactive.outcome, "rejected");
    if (inactive.outcome === "rejected") {
      assert.deepEqual([...inactive.reasons], ["inactive_execution"]);
    }
    const unknownTrial = process(
      store,
      call({ trial_id: "99999999-9999-4999-8999-999999999999" }),
    );
    assert.equal(unknownTrial.outcome, "rejected");
    store.seedPayment(TRIAL, { ...payment(), currency: "USD" as "BRL" });
    const mismatch = process(store, call());
    assert.equal(mismatch.outcome, "rejected");
    if (mismatch.outcome === "rejected") {
      assert.deepEqual([...mismatch.reasons], ["currency_mismatch"]);
    }
    store.transact([
      {
        collection: "executions",
        key: TRIAL,
        value: { ...execution(), trial_id: "99999999-9999-4999-8999-999999999999" },
      },
    ]);
    const mismatched = process(store, call());
    assert.equal(mismatched.outcome, "rejected");
    const unauth = process(store, call(), { principal: "other" });
    assert.equal(unauth.outcome, "rejected");
    if (unauth.outcome === "rejected") {
      assert.deepEqual([...unauth.reasons], ["unauthenticated"]);
      assert.equal(unauth.event, undefined);
    }
    const schema = process(store, "nope");
    assert.equal(schema.outcome, "rejected");
    if (schema.outcome === "rejected") {
      assert.deepEqual([...schema.reasons], ["not_an_object"]);
    }
  });

  it("leaves no records when an accept transact fails", () => {
    const store = seed("COMMIT_THEN_TIMEOUT");
    store.failNextTransact();
    const result = process(store);
    assert.equal(result.outcome, "failed");
    if (result.outcome === "failed") {
      assert.deepEqual([...result.reasons], ["transact_failed"]);
    }
    assert.equal(store.listLedger(TRIAL).length, 0);
    assert.equal(store.listJournal(TRIAL).length, 0);
    assert.equal(store.getTreatment(TRIAL)?.state, "ARMED");
  });

  it("leaves no reject journal when a reject transact fails", () => {
    const store = seed();
    store.failNextTransact();
    const result = process(store, call({ payment_id: "missing" }));
    assert.equal(result.outcome, "failed");
    assert.equal(store.listJournal(TRIAL).length, 0);
  });

  it("fails an accept with an invalid clock before writing", () => {
    const store = seed();
    const result = process(store, call(), { now: "not-a-time" });
    assert.equal(result.outcome, "failed");
    if (result.outcome === "failed") {
      assert.deepEqual([...result.reasons], ["invalid_event"]);
    }
    assert.equal(store.listLedger(TRIAL).length, 0);
  });

  it("rejects without a journal event when the reject clock is invalid", () => {
    const store = seed();
    const result = process(store, call({ payment_id: "missing" }), { now: "not-a-time" });
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") {
      assert.equal(result.event, undefined);
    }
    assert.equal(store.listJournal(TRIAL).length, 0);
  });

  it("generates identities and returns immediately when factories are omitted", () => {
    const store = seed("COMMIT_THEN_TIMEOUT");
    const result = processRefundCall(store, { principal: "variant", call: call() });
    assert.equal(result.outcome, "accepted");
    if (result.outcome === "accepted") {
      assert.match(result.provider_call_id, /^[0-9a-f-]{36}$/);
      assert.equal(result.transaction.status, "SUCCEEDED");
      assert.equal(result.treatment.state, "COMMITTED_WAITING");
      assert.equal(result.transaction.committed_at, store.listLedger(TRIAL)[0]?.committed_at);
    }
  });

  it("accepts the other execution bindings", () => {
    const probeStore = new InMemoryProviderStore();
    probeStore.seedPayment(TRIAL, payment());
    probeStore.seedExecution({
      trial_id: TRIAL,
      trial_manifest_sha256: DIGEST,
      scenario: "CONTROL",
      transport_probe_id: PROBE,
    });
    const probe = process(
      probeStore,
      call({ run_id: undefined, transport_probe_id: PROBE }),
    );
    assert.equal(probe.outcome, "accepted");
    const validationStore = new InMemoryProviderStore();
    validationStore.seedPayment(TRIAL, payment());
    validationStore.seedExecution({
      trial_id: TRIAL,
      trial_manifest_sha256: DIGEST,
      scenario: "CONTROL",
      variant_validation_id: VALIDATION,
    });
    const validation = process(
      validationStore,
      call({ run_id: undefined, variant_validation_id: VALIDATION }),
    );
    assert.equal(validation.outcome, "accepted");
  });
});

describe("ledger pagination", () => {
  function threeTransactions(): InMemoryProviderStore {
    const store = seed();
    for (const index of [0, 1, 2]) {
      assert.equal(process(store, call(), { ids: idsFor(index) }).outcome, "accepted");
    }
    return store;
  }

  const exec = { run_id: RUN, trial_manifest_sha256: DIGEST };

  it("marks a truncated walk incomplete and a full walk complete", () => {
    const store = threeTransactions();
    const first = readLedger(store, {
      principal: "independent",
      trial_id: TRIAL,
      execution: exec,
      limit: 1,
    });
    assert.equal(first.ok, true);
    if (!first.ok) {
      return;
    }
    assert.equal(first.complete, false);
    assert.equal(first.transactions.length, 1);
    assert.equal(typeof first.next_cursor, "string");
    const second = readLedger(store, {
      principal: "independent",
      trial_id: TRIAL,
      execution: exec,
      cursor: first.next_cursor,
      limit: 1,
    });
    assert.equal(second.ok, true);
    if (!second.ok) {
      return;
    }
    const third = readLedger(store, {
      principal: "independent",
      trial_id: TRIAL,
      execution: exec,
      cursor: second.next_cursor,
      limit: 1,
    });
    assert.equal(third.ok, true);
    if (!third.ok) {
      return;
    }
    assert.equal(third.complete, true);
    assert.equal(third.next_cursor, undefined);
    const all = readLedger(store, {
      principal: "independent",
      trial_id: TRIAL,
      execution: exec,
      limit: 100,
    });
    assert.equal(all.ok, true);
    if (all.ok) {
      assert.equal(all.complete, true);
      assert.equal(all.transactions.length, 3);
    }
  });

  it("does not truncate because of an expected size", () => {
    const store = threeTransactions();
    const page = readLedger(store, {
      principal: "independent",
      trial_id: TRIAL,
      execution: exec,
      limit: 2,
    });
    assert.equal(page.ok, true);
    if (page.ok) {
      assert.equal(page.complete, false);
      assert.equal(page.transactions.length, 2);
    }
  });

  it("rejects invalid cursors and page limits", () => {
    const store = threeTransactions();
    const cursor = readLedger(store, {
      principal: "independent",
      trial_id: TRIAL,
      execution: exec,
      cursor: "missing",
    });
    assert.equal(cursor.ok, false);
    if (!cursor.ok) {
      assert.deepEqual([...cursor.reasons], ["invalid_cursor"]);
    }
    const typed = readLedger(store, {
      principal: "independent",
      trial_id: TRIAL,
      execution: exec,
      cursor: 1,
    });
    assert.equal(typed.ok, false);
    const limit = readLedger(store, {
      principal: "independent",
      trial_id: TRIAL,
      execution: exec,
      limit: 0,
    });
    assert.equal(limit.ok, false);
    if (!limit.ok) {
      assert.deepEqual([...limit.reasons], ["invalid_page_limit"]);
    }
  });

  it("reads an empty ledger as complete", () => {
    const store = seed();
    const page = readLedger(store, {
      principal: "independent",
      trial_id: TRIAL,
      execution: exec,
    });
    assert.equal(page.ok, true);
    if (page.ok) {
      assert.equal(page.complete, true);
      assert.deepEqual(page.transactions, []);
    }
  });
});

describe("treatment and execution reads", () => {
  const exec = { run_id: RUN, trial_manifest_sha256: DIGEST };

  it("returns UNARMED when no treatment row exists", () => {
    const store = seed("CONTROL");
    const read = readTreatmentState(store, {
      principal: "independent",
      trial_id: TRIAL,
      execution: exec,
    });
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.treatment.state, "UNARMED");
    }
  });

  it("rejects reads that do not identify the active execution", () => {
    const store = seed();
    const missing = readLedger(store, {
      principal: "independent",
      trial_id: TRIAL,
      execution: "nope",
    });
    assert.equal(missing.ok, false);
    const digest = readTreatmentState(store, {
      principal: "independent",
      trial_id: TRIAL,
      execution: { run_id: RUN, trial_manifest_sha256: "b".repeat(64) },
    });
    assert.equal(digest.ok, false);
    const bindings = readLedger(store, {
      principal: "independent",
      trial_id: TRIAL,
      execution: { run_id: RUN, transport_probe_id: PROBE, trial_manifest_sha256: DIGEST },
    });
    assert.equal(bindings.ok, false);
    const trial = readLedger(store, {
      principal: "independent",
      trial_id: "not-uuid",
      execution: exec,
    });
    assert.equal(trial.ok, false);
    const unknownTrial = readLedger(store, {
      principal: "independent",
      trial_id: "99999999-9999-4999-8999-999999999999",
      execution: exec,
    });
    assert.equal(unknownTrial.ok, false);
    store.transact([
      {
        collection: "executions",
        key: TRIAL,
        value: {
          trial_id: "99999999-9999-4999-8999-999999999999",
          trial_manifest_sha256: DIGEST,
          scenario: "CONTROL",
          run_id: RUN,
        },
      },
    ]);
    const mismatched = readTreatmentState(store, {
      principal: "independent",
      trial_id: TRIAL,
      execution: exec,
    });
    assert.equal(mismatched.ok, false);
  });
});
