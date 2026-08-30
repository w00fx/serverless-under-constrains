import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createApprovedDecision,
  createEvidenceRefs,
  createPayment,
  createPrimaryEvent,
  serializeCanonicalJson,
  serializeCanonicalJsonl,
  sha256Hex,
  verifyCanonicalBytes,
  verifyDigest,
} from "../../src/protocol-records/index.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const PINNED = {
  "payment.json": "0ec766bea93b578355637b57e60a93d1c2ee534b71bb1de5403192e338fb5bf6",
  "approved_decision.json": "24225407c6b16ec06a69cf0658fd9ae9d8381639bbd8b93685f28ca6f377f09a",
  "evidence_refs.json": "bdc83836d71e0570d76c5afe64be629020c0c2c943dbbe3451b131118ee8a263",
  "primary-event.json": "0ef16789f89c9bbc6b14cedde95a90ea966c767b9d23a2b6e30eb7407843d6e0",
  "records.jsonl": "88d86b99406e042b73192dfdbd5bb23d0b188feb970d63d50e1ce4a07644f7be",
} as const;

const payment = createPayment({
  schema_version: 1,
  record_type: "payment",
  payment_id: "pay-poc-001",
  captured_amount_minor: 10000,
  currency: "BRL",
});
const decision = createApprovedDecision({
  schema_version: 1,
  record_type: "approved_decision",
  refund_request_id: "ref-poc-001",
  payment_id: "pay-poc-001",
  decision: "APPROVED",
  approved_amount_minor: 10000,
  currency: "BRL",
});
const refs = createEvidenceRefs([
  { artifact_path: "z/b.json", artifact_sha256: DIGEST, json_pointer: "/b" },
  {
    artifact_path: "a/a.json",
    artifact_sha256: DIGEST,
    event_id: "11111111-1111-4111-8111-111111111111",
  },
]);
const primary = createPrimaryEvent({
  schema_version: 1,
  record_type: "caller_journal",
  event_id: "11111111-1111-4111-8111-111111111111",
  occurred_at: "2026-08-29T12:00:00.000Z",
  source: "runner",
  source_instance_id: "22222222-2222-4222-8222-222222222222",
  source_sequence: 1,
  run_id: "33333333-3333-4333-8333-333333333333",
  trial_manifest_sha256: DIGEST,
  causation_event_ids: [
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ],
});

describe("locked protocol-record fixtures", () => {
  it("reproduces exact canonical bytes and pinned digests", () => {
    assert.equal(payment.ok && decision.ok && refs.ok && primary.ok, true);
    if (!payment.ok || !decision.ok || !refs.ok || !primary.ok) {
      return;
    }
    const generated = {
      "payment.json": serializeCanonicalJson(payment.value),
      "approved_decision.json": serializeCanonicalJson(decision.value),
      "evidence_refs.json": serializeCanonicalJson(refs.value),
      "primary-event.json": serializeCanonicalJson(primary.value),
      "records.jsonl": serializeCanonicalJsonl([payment.value, decision.value, primary.value]),
    };
    for (const [name, digest] of Object.entries(PINNED)) {
      const result = generated[name as keyof typeof generated];
      assert.equal(result.ok, true, name);
      if (!result.ok) {
        continue;
      }
      const stored = readFileSync(join(dir, "protocol-records", name), "utf8");
      assert.equal(result.value, stored, name);
      assert.equal(sha256Hex(stored), digest, name);
      assert.equal(verifyDigest(stored, digest).ok, true, name);
      if (name === "payment.json") {
        assert.equal(verifyCanonicalBytes(payment.value, stored).ok, true);
      }
      if (name === "approved_decision.json") {
        assert.equal(verifyCanonicalBytes(decision.value, stored).ok, true);
      }
      if (name === "evidence_refs.json") {
        assert.equal(verifyCanonicalBytes(refs.value, stored).ok, true);
      }
      if (name === "primary-event.json") {
        assert.equal(verifyCanonicalBytes(primary.value, stored).ok, true);
      }
    }
  });
});
