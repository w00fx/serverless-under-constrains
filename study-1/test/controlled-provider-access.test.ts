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
import type { Principal, ProviderOperation } from "../src/controlled-provider/types.ts";
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

  // A `Record<ProviderOperation, ...>` literal fails to compile if a new
  // operation is declared without deciding who may call it.
  const PERMITTED: Record<ProviderOperation, readonly Principal[]> = {
    refund: ["variant", "independent"],
    read_ledger: ["independent"],
    read_treatment_state: ["independent"],
  };

  it("authorizes every declared principal and operation exactly once", () => {
    for (const [operation, permitted] of Object.entries(PERMITTED) as [
      ProviderOperation,
      readonly Principal[],
    ][]) {
      for (const principal of ["variant", "independent"] as const) {
        const decision = authorize(principal, operation);
        assert.equal(
          decision.ok,
          permitted.includes(principal),
          `${principal} -> ${operation}`,
        );
        if (!decision.ok) {
          assert.deepEqual([...decision.reasons], ["unauthorized"]);
        }
      }
    }
  });

  it("treats an undeclared principal as unauthenticated", () => {
    const decision = authorize("operator", "refund");
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.deepEqual([...decision.reasons], ["unauthenticated"]);
    }
  });

  it("denies exactly the operations it does not allow, plus provider status", () => {
    for (const principal of ["variant", "independent"] as const) {
      const { allow, deny } = AUTHORIZATION[principal];
      const unallowed = (Object.keys(PERMITTED) as ProviderOperation[]).filter(
        (operation) => !allow.includes(operation),
      );
      assert.deepEqual([...deny].toSorted(), [...unallowed, "provider_status"].toSorted());
    }
  });

  it("declares strongly consistent trial-scoped tables", () => {
    assert.equal(PROVIDER_TABLES.length, 5);
    assert.deepEqual(
      PROVIDER_TABLES.filter(
        (table) => !table.consistent_read || table.partition_key !== "trial_id",
      ),
      [],
    );
  });
});
