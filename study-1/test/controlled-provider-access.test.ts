import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTHORIZATION,
  authorize,
  InMemoryProviderStore,
  PROVIDER_TABLES,
  processRefundCall,
  readLedger,
  readTreatmentState,
} from "../src/controlled-provider/index.ts";
import { createPayment } from "../src/protocol-records/index.ts";

const DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const TRIAL = "66666666-6666-4666-8666-666666666666";
const RUN = "33333333-3333-4333-8333-333333333333";

function store(): InMemoryProviderStore {
  const seeded = new InMemoryProviderStore();
  const payment = createPayment({
    schema_version: 1,
    record_type: "payment",
    payment_id: "pay-poc-001",
    captured_amount_minor: 10000,
    currency: "BRL",
  });
  assert.equal(payment.ok, true);
  if (payment.ok) {
    seeded.seedPayment(TRIAL, payment.value);
  }
  seeded.seedExecution({
    trial_id: TRIAL,
    trial_manifest_sha256: DIGEST,
    scenario: "CONTROL",
    run_id: RUN,
  });
  return seeded;
}

const execution = { run_id: RUN, trial_manifest_sha256: DIGEST };

describe("BR-5 authority boundary", () => {
  it("lets a variant invoke refund and denies ledger and treatment reads", () => {
    const seeded = store();
    const refund = processRefundCall(seeded, {
      principal: "variant",
      call: {
        schema_version: 1,
        record_type: "refund_call",
        run_id: RUN,
        trial_id: TRIAL,
        trial_manifest_sha256: DIGEST,
        attempt_id: "11111111-1111-4111-8111-111111111111",
        provider_request_id: "77777777-7777-4777-8777-777777777777",
        payment_id: "pay-poc-001",
        refund_request_id: "ref-poc-001",
        amount_minor: 10000,
        currency: "BRL",
      },
    });
    assert.equal(refund.outcome, "accepted");
    const ledger = readLedger(seeded, {
      principal: "variant",
      trial_id: TRIAL,
      execution,
    });
    assert.equal(ledger.ok, false);
    if (!ledger.ok) {
      assert.deepEqual([...ledger.reasons], ["unauthorized"]);
    }
    const treatment = readTreatmentState(seeded, {
      principal: "variant",
      trial_id: TRIAL,
      execution,
    });
    assert.equal(treatment.ok, false);
    if (!treatment.ok) {
      assert.deepEqual([...treatment.reasons], ["unauthorized"]);
    }
  });

  it("lets the independent path read the complete ledger and treatment state", () => {
    const seeded = store();
    const ledger = readLedger(seeded, {
      principal: "independent",
      trial_id: TRIAL,
      execution,
    });
    assert.equal(ledger.ok, true);
    if (ledger.ok) {
      assert.equal(ledger.complete, true);
    }
    const treatment = readTreatmentState(seeded, {
      principal: "independent",
      trial_id: TRIAL,
      execution,
    });
    assert.equal(treatment.ok, true);
  });

  it("does not expose a provider-status operation", () => {
    const variant = authorize("variant", "refund");
    assert.equal(variant.ok, true);
    assert.equal(AUTHORIZATION.variant.allow.includes("refund"), true);
    assert.equal(AUTHORIZATION.variant.deny.includes("provider_status"), true);
    assert.equal(AUTHORIZATION.independent.deny.includes("provider_status"), true);
    assert.equal(
      AUTHORIZATION.variant.allow.includes("read_ledger" as "refund"),
      false,
    );
    const denied = authorize("variant", "read_ledger");
    assert.equal(denied.ok, false);
  });

  it("declares strongly consistent trial-scoped tables and the IAM matrix", () => {
    assert.equal(PROVIDER_TABLES.every((table) => table.consistent_read), true);
    assert.deepEqual(
      PROVIDER_TABLES.map((table) => table.partition_key),
      [
        "trial_id",
        "trial_id",
        "trial_id",
        "trial_id",
        "trial_id",
      ],
    );
    assert.deepEqual([...AUTHORIZATION.variant.deny].toSorted(), [
      "provider_status",
      "read_ledger",
      "read_treatment_state",
    ]);
    assert.deepEqual([...AUTHORIZATION.independent.allow].toSorted(), [
      "read_ledger",
      "read_treatment_state",
      "refund",
    ]);
  });
});
