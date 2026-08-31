import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COORDINATION_STACK_ID } from "../../src/coordination/identity.ts";
import { classifyLeaseForDestroy } from "../../src/coordination/leases.ts";
import type { LeaseItem } from "../../src/coordination/types.ts";
import { collectRequestIdentityReasons } from "../../src/coordination/verify.ts";

const SEED = 20260830;
const VERDICTS = new Set([
  "allow",
  "active",
  "non_stale",
  "recovery_required",
  "unverified",
]);
const REQUEST_CODES = new Set([
  "account_not_12_digit",
  "account_not_allowlisted",
  "region_not_allowed",
  "coordination_stack_identity_mismatch",
]);

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

const HOSTILE: readonly unknown[] = [
  undefined,
  null,
  0,
  1,
  "1",
  "01",
  "",
  "   ",
  "us-east-1",
  "us-west-2",
  "123456789012",
  "999999999999",
  "123",
  COORDINATION_STACK_ID,
  "other-stack",
  "released",
  "recovery_required",
  "unverified",
  "TRANSPORT_PROBE",
  "2026-08-30T21:00:00.000Z",
  "not-a-time",
  [],
  {},
  true,
  false,
];

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

describe("fuzz-study-1 coordination (seed 20260830)", () => {
  it("classifies generated lease items without throwing and reports only declared verdicts", () => {
    const rng = mulberry32(SEED);
    const now = new Date("2026-08-30T21:00:00.000Z");
    const keys = [
      "lease_key",
      "schema_version",
      "owner_kind",
      "owner_id",
      "heartbeat",
      "lease_status",
      "extra",
    ] as const;
    for (let i = 0; i < 2000; i += 1) {
      const item: LeaseItem = {};
      const mutations = 1 + Math.floor(rng() * 4);
      for (let j = 0; j < mutations; j += 1) {
        const key = pick(rng, keys);
        Object.defineProperty(item, key, {
          configurable: true,
          enumerable: true,
          value: pick(rng, HOSTILE),
          writable: true,
        });
      }
      const verdict = classifyLeaseForDestroy(
        rng() < 0.1 ? (pick(rng, HOSTILE) as LeaseItem) : item,
        now,
      );
      assert.ok(VERDICTS.has(verdict), `unexpected verdict ${verdict} at ${i}`);
    }
  });

  it("rejects generated request identities with declared codes only", () => {
    const rng = mulberry32(SEED + 1);
    const validReasons = collectRequestIdentityReasons(
      {
        allowlistedAccountId: "123456789012",
        region: "us-east-1",
        stackId: COORDINATION_STACK_ID,
      },
      "123456789012",
    );
    assert.deepEqual(validReasons, []);

    for (let i = 0; i < 500; i += 1) {
      const allowlisted = pick(rng, HOSTILE);
      const caller = pick(rng, ["123456789012", "999999999999", "abc", 12, ""]);
      const reasons = collectRequestIdentityReasons(
        {
          allowlistedAccountId: allowlisted,
          region: pick(rng, HOSTILE),
          stackId: pick(rng, HOSTILE),
        },
        String(caller),
      );
      if (reasons.length === 0) {
        assert.equal(allowlisted, "123456789012");
        assert.equal(String(caller), "123456789012");
        continue;
      }
      for (const reason of reasons) {
        assert.ok(REQUEST_CODES.has(reason.code), reason.code);
      }
    }
  });
});
