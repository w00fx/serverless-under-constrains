import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRefundCall } from "../../src/controlled-provider/index.ts";

const SEED = 20260830;
const DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CALL = {
  schema_version: 1,
  record_type: "refund_call",
  run_id: "33333333-3333-4333-8333-333333333333",
  trial_id: "66666666-6666-4666-8666-666666666666",
  trial_manifest_sha256: DIGEST,
  attempt_id: "11111111-1111-4111-8111-111111111111",
  provider_request_id: "77777777-7777-4777-8777-777777777777",
  payment_id: "pay-poc-001",
  refund_request_id: "ref-poc-001",
  amount_minor: 10000,
  currency: "BRL",
};

describe("fuzz-study-1 controlled-provider (seed 20260830)", () => {
  it("rejects generated invalid refund-call amounts and identities", () => {
    const rng = mulberry32(SEED);
    const amounts = [0, -1, -0, 1.25, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
    for (let i = 0; i < 64; i += 1) {
      const amount = amounts[Math.floor(rng() * amounts.length)];
      const result = createRefundCall({ ...CALL, amount_minor: amount });
      assert.equal(result.ok, false, `amount ${String(amount)} seed-step ${i}`);
    }
    for (let i = 0; i < 32; i += 1) {
      const identity = rng() < 0.5 ? "" : "   ";
      const result = createRefundCall({ ...CALL, payment_id: identity });
      assert.equal(result.ok, false, `identity seed-step ${i}`);
    }
  });
});
