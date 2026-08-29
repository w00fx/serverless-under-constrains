import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  classifyEventSequence,
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

const PAYMENT_SHA256 = "0ec766bea93b578355637b57e60a93d1c2ee534b71bb1de5403192e338fb5bf6";
const DECISION_SHA256 = "24225407c6b16ec06a69cf0658fd9ae9d8381639bbd8b93685f28ca6f377f09a";
const EVIDENCE_REFS_SHA256 =
  "95b565bd4b1991dd43b788acedfbefe9ddcc76e336c1fd258d015af474feb487";
const PRIMARY_EVENT_SHA256 =
  "afa586871dbffc9c8f865ec8f769f1f023ddee08197a1d24391d3ff6db9d971c";
const RECORDS_JSONL_SHA256 =
  "978623a267a75c0e138373cf2c117e7e531095bf012ddbe2e2bd9773912b7dd3";
const PAYMENT_SCHEMA_SHA256 =
  "d6574bbe64d2ab9fcda7572464a23ec278d85ed1332d95485c8ec3ace7fcafcc";
const DECISION_SCHEMA_SHA256 =
  "d7a86fe371bdd363523e4e37d3b04888debb2a02c6e664976ee8066388693bad";
const EVIDENCE_REF_SCHEMA_SHA256 =
  "4f6a98e4f8c386df039f1e9fe397c8ab5126e4b681f5eec404fca4d02317ed99";

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
  assert.equal(sha256Bytes(first), PAYMENT_SHA256);
  const verified = verifyCanonicalJson(golden, PAYMENT_SHA256);
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
  assert.equal(sha256Bytes(bytes), DECISION_SHA256);
  assert.equal(verifyCanonicalJson(golden, DECISION_SHA256).ok, true);
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
  assert.equal(sha256Bytes(bytes), EVIDENCE_REFS_SHA256);
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
  assert.equal(sha256Bytes(bytes), PRIMARY_EVENT_SHA256);
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
  assert.equal(sha256Bytes(first), RECORDS_JSONL_SHA256);
  const verified = verifyCanonicalJsonl(golden, RECORDS_JSONL_SHA256);
  assert.equal(verified.ok, true);
});

test("M0-A#ref1 sorts evidence_refs by code-unit order, not locale collation", () => {
  const created = createEvidenceRefs([
    { artifact_path: "events/caller.jsonl", artifact_sha256: "a".repeat(64) },
    { artifact_path: "Ledger/x.json", artifact_sha256: "b".repeat(64) },
    { artifact_path: "events-caller.jsonl", artifact_sha256: "c".repeat(64) },
  ]);
  assert.equal(created.ok, true);
  if (!created.ok) {
    throw new Error("expected refs");
  }
  assert.deepEqual(
    created.value.map((entry) => entry.artifact_path),
    ["Ledger/x.json", "events-caller.jsonl", "events/caller.jsonl"],
  );
});

test("M0-A#refused keeps an extra __proto__ field as an own property", () => {
  const created = createPrimaryEvent(
    JSON.parse(`{
      "schema_version": 1,
      "record_type": "dispatch_started",
      "event_id": "11111111-1111-4111-8111-111111111111",
      "occurred_at": "2026-08-25T17:17:00.000Z",
      "source": "caller",
      "source_instance_id": "22222222-2222-4222-8222-222222222222",
      "source_sequence": 1,
      "trial_manifest_sha256": "${"c".repeat(64)}",
      "run_id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "__proto__": { "pwned": true }
    }`),
  );
  assert.equal(created.ok, true);
  if (!created.ok) {
    throw new Error("expected event");
  }
  assert.equal(Object.hasOwn(created.value, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(created.value) === Object.prototype, true);
  assert.equal((created.value as { pwned?: boolean }).pwned, undefined);
  const bytes = serializeCanonicalJson(created.value);
  assert.match(bytes, /"__proto__"/);
  const withoutExtra = createPrimaryEvent({
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
  assert.equal(withoutExtra.ok, true);
  if (!withoutExtra.ok) {
    throw new Error("expected event");
  }
  assert.notEqual(sha256Bytes(bytes), sha256Bytes(serializeCanonicalJson(withoutExtra.value)));
});

test("M0-A#refused rejects an unserializable sequence event instead of throwing", () => {
  const result = classifyEventSequence([
    {
      event_id: "11111111-1111-4111-8111-111111111111",
      source: "caller",
      source_instance_id: "22222222-2222-4222-8222-222222222222",
      source_sequence: 1,
      extra: 1n,
    },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected rejection");
  }
  assert.equal(result.reasons[0]?.code, "unserializable_event");
});

test("M0-A#row1 keeps ingestion-duplicate counts when a sequence gap is also present", () => {
  const event = {
    event_id: "11111111-1111-4111-8111-111111111111",
    source: "caller",
    source_instance_id: "22222222-2222-4222-8222-222222222222",
    source_sequence: 1,
  };
  const result = classifyEventSequence([
    event,
    event,
    {
      event_id: "33333333-3333-4333-8333-333333333333",
      source: "caller",
      source_instance_id: "22222222-2222-4222-8222-222222222222",
      source_sequence: 3,
    },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected rejection");
  }
  assert.ok(result.reasons.some((reason) => reason.code === "source_sequence_gap"));
  assert.deepEqual(result.duplicate_event_ids, [
    { event_id: "11111111-1111-4111-8111-111111111111", count: 2 },
  ]);
});

test("M0-A#refused names invalid JSON, unsorted JSONL, and a malformed expected digest", () => {
  const invalidJson = verifyCanonicalJson("{");
  assert.equal(invalidJson.ok, false);
  if (invalidJson.ok) {
    throw new Error("expected rejection");
  }
  assert.equal(invalidJson.reasons[0]?.code, "invalid_json");

  const unsortedLine = verifyCanonicalJsonl(
    '{"schema_version":1,"record_type":"payment"}\n',
  );
  assert.equal(unsortedLine.ok, false);
  if (unsortedLine.ok) {
    throw new Error("expected rejection");
  }
  assert.equal(unsortedLine.reasons[0]?.code, "jsonl_line_not_canonical");

  const bytes = serializeCanonicalJson({ schema_version: 1, record_type: "payment" });
  const badDigest = verifyCanonicalJson(bytes, "not-a-digest");
  assert.equal(badDigest.ok, false);
  if (badDigest.ok) {
    throw new Error("expected rejection");
  }
  assert.equal(badDigest.reasons[0]?.code, "invalid_sha256");
});

test("M0-A#refused rejects a non-array event sequence and duplicate causation ids", () => {
  const notArray = classifyEventSequence("not-an-array");
  assert.equal(notArray.ok, false);
  if (notArray.ok) {
    throw new Error("expected rejection");
  }
  assert.equal(notArray.reasons[0]?.code, "not_an_array");

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
    causation_event_ids: [
      "11111111-1111-4111-8111-111111111111",
      "11111111-1111-4111-8111-111111111111",
    ],
  });
  assert.equal(created.ok, false);
  if (created.ok) {
    throw new Error("expected rejection");
  }
  assert.ok(created.reasons.some((reason) => reason.code === "duplicate_causation_event_id"));
});

test("M0-A#ref1 schema descriptors keep stable record_schema digests", async () => {
  const schemaDir = fileURLToPath(new URL("../../src/protocol-records/schemas/", import.meta.url));
  const payment = await readFile(join(schemaDir, "payment.v1.json"));
  const decision = await readFile(join(schemaDir, "approved_decision.v1.json"));
  const evidenceRef = await readFile(join(schemaDir, "evidence_ref.v1.json"));
  assert.equal(sha256Bytes(payment), PAYMENT_SCHEMA_SHA256);
  assert.equal(sha256Bytes(decision), DECISION_SCHEMA_SHA256);
  assert.equal(sha256Bytes(evidenceRef), EVIDENCE_REF_SCHEMA_SHA256);
});

