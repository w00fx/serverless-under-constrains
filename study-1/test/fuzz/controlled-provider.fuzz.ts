import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRefundCall } from "../../src/controlled-provider/index.ts";
import {
  isPositiveSafeInteger,
  isSha256Hex,
  isUuidV4,
} from "../../src/protocol-records/primitives.ts";

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

const BINDING_KEYS = ["run_id", "transport_probe_id", "variant_validation_id"] as const;

// Every reason `createRefundCall` is allowed to report. A generated input that
// produces anything else means the validator grew an undeclared rejection.
const REASONS = new Set([
  "not_an_object",
  "unknown_property",
  "alias_rejected",
  "invalid_schema_version",
  "invalid_record_type",
  "missing_execution_binding",
  "ambiguous_execution_binding",
  "invalid_uuid",
  "invalid_sha256",
  "empty_identity",
  "invalid_identifier",
  "invalid_amount",
  "invalid_currency",
]);

const HOSTILE: readonly unknown[] = [
  undefined,
  null,
  0,
  -1,
  -0,
  1.25,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
  Number.MAX_SAFE_INTEGER,
  true,
  false,
  "",
  "   ",
  "\u00a0\u2003",
  " pay-poc-001 ",
  "REF-POC-001",
  "33333333-3333-4333-8333-333333333333",
  "33333333-3333-4333-8333-333333333333 ",
  "33333333-3333-3333-8333-333333333333",
  "33333333-3333-4333-C333-333333333333",
  "3333333333334333833333333333333",
  DIGEST,
  DIGEST.toUpperCase(),
  `${DIGEST}0`,
  "BRL",
  "brl",
  "USD",
  1,
  [],
  ["BRL"],
  {},
  { toString: null },
];

const MUTABLE_KEYS = [
  ...Object.keys(CALL),
  "transport_probe_id",
  "variant_validation_id",
  "extra",
  "evidence",
  "evidence_references",
  "references",
  "__proto__",
] as const;

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function mutate(rng: () => number): Record<string, unknown> {
  const input: Record<string, unknown> = { ...CALL };
  const mutations = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < mutations; i += 1) {
    const key = pick(rng, MUTABLE_KEYS);
    const value = pick(rng, HOSTILE);
    if (value === undefined) {
      delete input[key];
    } else {
      // Own-property assignment, so a generated `__proto__` key stays data
      // instead of reaching the inherited prototype setter.
      Object.defineProperty(input, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    }
  }
  return input;
}

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

  it("decides every mutated call without throwing and reports only declared reasons", () => {
    const rng = mulberry32(SEED);
    for (let i = 0; i < 2000; i += 1) {
      const input = mutate(rng);
      const where = `seed-step ${i}: ${JSON.stringify(input)}`;
      const result = createRefundCall(input);
      if (result.ok) {
        continue;
      }
      assert.ok(result.reasons.length > 0, where);
      assert.deepEqual([...new Set(result.reasons)], [...result.reasons], where);
      for (const reason of result.reasons) {
        assert.ok(REASONS.has(reason), `${reason} not declared — ${where}`);
      }
    }
  });

  it("only accepts mutated calls that satisfy every admission invariant", () => {
    const rng = mulberry32(SEED + 1);
    let accepted = 0;
    for (let i = 0; i < 2000; i += 1) {
      const input = mutate(rng);
      const result = createRefundCall(input);
      if (!result.ok) {
        continue;
      }
      accepted += 1;
      const where = `seed-step ${i}: ${JSON.stringify(input)}`;
      const value = result.value;
      assert.equal(value.schema_version, 1, where);
      assert.equal(value.record_type, "refund_call", where);
      assert.equal(value.currency, "BRL", where);
      assert.ok(isPositiveSafeInteger(value.amount_minor), where);
      assert.ok(isUuidV4(value.trial_id), where);
      assert.ok(isUuidV4(value.attempt_id), where);
      assert.ok(isUuidV4(value.provider_request_id), where);
      assert.ok(isSha256Hex(value.trial_manifest_sha256), where);
      assert.equal(value.payment_id, value.payment_id.trim(), where);
      assert.equal(value.refund_request_id, value.refund_request_id.trim(), where);
      assert.notEqual(value.payment_id, "", where);
      assert.notEqual(value.refund_request_id, "", where);
      const bindings = BINDING_KEYS.filter((key) => value[key] !== undefined);
      assert.equal(bindings.length, 1, where);
      assert.ok(isUuidV4(value[bindings[0]!]), where);
    }
    // A generator that never produces an acceptable call would make the
    // postcondition above vacuous.
    assert.ok(accepted > 0, `no mutated call was accepted (${String(accepted)})`);
  });
});
