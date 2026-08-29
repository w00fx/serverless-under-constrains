import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  createApprovedDecision,
  createEvidenceRefs,
  createPayment,
  createPrimaryEvent,
  serializeCanonicalJson,
  serializeCanonicalJsonl,
  sha256Bytes,
  verifyCanonicalJson,
  verifyCanonicalJsonl,
} from "../../src/protocol-records/index.ts";

const GOLDEN_DIR = fileURLToPath(new URL("./protocol-records/", import.meta.url));

async function readGolden(name: string): Promise<string> {
  return readFile(join(GOLDEN_DIR, name), "utf8");
}

test("M0-A#ref1 payment golden bytes and digest repeat across runs", async () => {
  const golden = await readGolden("payment.json");
  const created = createPayment({
    schema_version: 1,
    record_type: "payment",
    payment_id: "pay-poc-001",
    captured_amount_minor: 10000,
    currency: "BRL",
  });
  assert.equal(created.ok, true);
  if (!created.ok) {
    throw new Error("expected payment");
  }
  const first = serializeCanonicalJson(created.value);
  const second = serializeCanonicalJson(created.value);
  assert.equal(first, golden);
  assert.equal(second, golden);
  assert.equal(sha256Bytes(first), sha256Bytes(golden));
  const verified = verifyCanonicalJson(golden, sha256Bytes(golden));
  assert.equal(verified.ok, true);
});

test("M0-A#ref2 approved_decision golden bytes and digest repeat across runs", async () => {
  const golden = await readGolden("approved_decision.json");
  const created = createApprovedDecision({
    schema_version: 1,
    record_type: "approved_decision",
    refund_request_id: "ref-poc-001",
    payment_id: "pay-poc-001",
    decision: "APPROVED",
    approved_amount_minor: 10000,
    currency: "BRL",
  });
  assert.equal(created.ok, true);
  if (!created.ok) {
    throw new Error("expected decision");
  }
  const bytes = serializeCanonicalJson(created.value);
  assert.equal(bytes, golden);
  assert.equal(sha256Bytes(bytes), sha256Bytes(golden));
  assert.equal(verifyCanonicalJson(golden, sha256Bytes(golden)).ok, true);
});

test("M0-A#ref1 evidence_refs golden is the sorted canonical collection", async () => {
  const golden = await readGolden("evidence_refs.json");
  const created = createEvidenceRefs([
    {
      artifact_path: "ledger/snapshot.json",
      artifact_sha256: "b".repeat(64),
      json_pointer: "/transactions/0",
    },
    {
      artifact_path: "events/caller.jsonl",
      artifact_sha256: "a".repeat(64),
      event_id: "11111111-1111-4111-8111-111111111111",
    },
  ]);
  assert.equal(created.ok, true);
  if (!created.ok) {
    throw new Error("expected refs");
  }
  const bytes = serializeCanonicalJson(created.value);
  assert.equal(bytes, golden);
  assert.equal(sha256Bytes(bytes), sha256Bytes(golden));
});

test("M0-A#ref1 primary-event golden bytes and digest repeat across runs", async () => {
  const golden = await readGolden("primary-event.json");
  const created = createPrimaryEvent({
    schema_version: 1,
    record_type: "dispatch_started",
    event_id: "11111111-1111-4111-8111-111111111111",
    occurred_at: "2026-08-25T17:17:00.000Z",
    source: "caller",
    source_instance_id: "22222222-2222-4222-8222-222222222222",
    source_sequence: 1,
    trial_manifest_sha256: "c".repeat(64),
    run_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  });
  assert.equal(created.ok, true);
  if (!created.ok) {
    throw new Error("expected event");
  }
  const bytes = serializeCanonicalJson(created.value);
  assert.equal(bytes, golden);
  assert.equal(sha256Bytes(bytes), sha256Bytes(golden));
});

test("M0-A#ref1 JSONL golden reproduces compact canonical bytes and digest", async () => {
  const golden = await readGolden("records.jsonl");
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
  const root = createPrimaryEvent({
    schema_version: 1,
    record_type: "dispatch_started",
    event_id: "11111111-1111-4111-8111-111111111111",
    occurred_at: "2026-08-25T17:17:00.000Z",
    source: "caller",
    source_instance_id: "22222222-2222-4222-8222-222222222222",
    source_sequence: 1,
    trial_manifest_sha256: "c".repeat(64),
    run_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  });
  const caused = createPrimaryEvent({
    schema_version: 1,
    record_type: "caller_timeout_recorded",
    event_id: "33333333-3333-4333-8333-333333333333",
    occurred_at: "2026-08-25T17:17:03.000Z",
    source: "caller",
    source_instance_id: "22222222-2222-4222-8222-222222222222",
    source_sequence: 2,
    trial_manifest_sha256: "c".repeat(64),
    run_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    causation_event_ids: ["11111111-1111-4111-8111-111111111111"],
  });
  assert.ok(payment.ok && decision.ok && root.ok && caused.ok);
  if (!payment.ok || !decision.ok || !root.ok || !caused.ok) {
    throw new Error("expected records");
  }
  const first = serializeCanonicalJsonl([
    payment.value,
    decision.value,
    root.value,
    caused.value,
  ]);
  const second = serializeCanonicalJsonl([
    payment.value,
    decision.value,
    root.value,
    caused.value,
  ]);
  assert.equal(first, golden);
  assert.equal(second, golden);
  assert.equal(sha256Bytes(first), sha256Bytes(golden));
  const verified = verifyCanonicalJsonl(golden, sha256Bytes(golden));
  assert.equal(verified.ok, true);
});
