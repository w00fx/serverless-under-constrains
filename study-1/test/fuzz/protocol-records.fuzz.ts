import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPayment } from "../../src/protocol-records/index.ts";

const SEED = 20260829;

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

const PAYMENT = {
  schema_version: 1,
  record_type: "payment",
  payment_id: "pay-poc-001",
  captured_amount_minor: 10000,
  currency: "BRL",
};

describe("fuzz-study-1 protocol-records (seed 20260829)", () => {
  it("rejects generated invalid payment amounts and identities", () => {
    const rng = mulberry32(SEED);
    const amounts = [0, -1, -0, 1.25, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
    for (let i = 0; i < 64; i += 1) {
      const amount = amounts[Math.floor(rng() * amounts.length)];
      const result = createPayment({ ...PAYMENT, captured_amount_minor: amount });
      assert.equal(result.ok, false, `amount ${String(amount)} seed-step ${i}`);
    }
    for (let i = 0; i < 32; i += 1) {
      const identity = rng() < 0.5 ? "" : "   ";
      const result = createPayment({ ...PAYMENT, payment_id: identity });
      assert.equal(result.ok, false, `identity seed-step ${i}`);
    }
  });
});
