import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createAttemptIdentities,
  createRetryEnvelope,
  InMemoryCallerJournal,
  invokeAttempt,
  projectKnowledge,
  projectProcessing,
} from "../../src/caller/index.ts";
import type { AttemptRecord } from "../../src/caller/types.ts";
import { isUuidV4 } from "../../src/protocol-records/primitives.ts";

const SEED = 20260903;
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

const HOSTILE: readonly unknown[] = [
  undefined,
  null,
  0,
  -1,
  1.5,
  "",
  "   ",
  [],
  { refund_request_id: "" },
  { inner_remaining: -1, upstream_remaining: 0 },
  { inner_remaining: Number.NaN, upstream_remaining: 0 },
];

const IDENTITY_REASONS = new Set(["not_an_object", "empty_identity", "invalid_identifier", "invalid_uuid"]);
const ENVELOPE_REASONS = new Set(["not_an_object", "invalid_retry_envelope"]);

const OUTCOMES = ["SUCCEEDED", "REJECTED", "TIMED_OUT", "FAILED"] as const;
const DISPATCH = ["NOT_DISPATCHED", "DISPATCHED", "UNKNOWN"] as const;

describe("fuzz-study-1 caller (seed 20260903)", () => {
  it("rejects hostile identity and envelope inputs with declared reasons", () => {
    const rng = mulberry32(SEED);
    for (let i = 0; i < 64; i += 1) {
      const input = HOSTILE[Math.floor(rng() * HOSTILE.length)];
      const identities = createAttemptIdentities(input);
      if (identities.ok) {
        assert.equal(isUuidV4(identities.value.attempt_id), true);
        continue;
      }
      for (const reason of identities.reasons) {
        assert.equal(IDENTITY_REASONS.has(reason), true, `identity ${reason} seed-step ${i}`);
      }
      const envelope = createRetryEnvelope(input);
      if (!envelope.ok) {
        for (const reason of envelope.reasons) {
          assert.equal(ENVELOPE_REASONS.has(reason), true, `envelope ${reason} seed-step ${i}`);
        }
      }
    }
  });

  it("keeps UNKNOWN absorbing across generated later attempt outcomes", () => {
    const rng = mulberry32(SEED);
    for (let i = 0; i < 48; i += 1) {
      const later: AttemptRecord = {
        attempt_id: `31111111-1111-4111-8111-11111111111${i % 10}`,
        provider_request_id: "77777777-7777-4777-8777-777777777777",
        refund_request_id: "ref-poc-001",
        outcome: OUTCOMES[Math.floor(rng() * OUTCOMES.length)]!,
        dispatch_state: DISPATCH[Math.floor(rng() * DISPATCH.length)]!,
      };
      const knowledge = projectKnowledge([
        {
          attempt_id: "11111111-1111-4111-8111-111111111111",
          provider_request_id: "77777777-7777-4777-8777-777777777777",
          refund_request_id: "ref-poc-001",
          outcome: "TIMED_OUT",
          dispatch_state: "DISPATCHED",
        },
        later,
      ]);
      assert.equal(knowledge, "UNKNOWN", `seed-step ${i}`);
    }
  });

  it("rejects hostile invoke requests before journal writes", async () => {
    const rng = mulberry32(SEED);
    const amounts = [0, -1, 1.25, Number.NaN, ""];
    for (let i = 0; i < 32; i += 1) {
      const journal = new InMemoryCallerJournal();
      const result = await invokeAttempt(
        {
          run_id: "33333333-3333-4333-8333-333333333333",
          trial_id: "66666666-6666-4666-8666-666666666666",
          trial_manifest_sha256: DIGEST,
          payment_id: rng() < 0.5 ? "" : "pay-poc-001",
          refund_request_id: rng() < 0.5 ? "" : "ref-poc-001",
          amount_minor: amounts[Math.floor(rng() * amounts.length)],
          currency: rng() < 0.5 ? "USD" : "BRL",
        },
        {
          journal,
          transport: { invoke: async () => ({ layer: "transport", kind: "error", reasons: ["x"] }) },
        },
      );
      assert.equal(result.ok, false, `invoke seed-step ${i}`);
      assert.equal(journal.list().length, 0, `journal seed-step ${i}`);
    }
    const processing = projectProcessing([], { inner_remaining: Number.POSITIVE_INFINITY, upstream_remaining: 0 });
    assert.equal(processing.ok, false);
  });
});
