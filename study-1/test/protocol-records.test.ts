import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALLOWED_CURRENCY,
  classifyEventSequence,
  createApprovedDecision,
  createEvidenceRefs,
  createPayment,
  createPrimaryEvent,
  isCanonicalJsonPointer,
  isCanonicalMonotonicNanos,
  isCanonicalRecordType,
  isCanonicalUtcMillisecondTimestamp,
  isLowercaseUuidV4,
  isNonemptyTrimmedIdentifier,
  isNormalizedRelativePosixPath,
  isPositiveSafeAmountMinor,
  isPositiveSafeSequence,
  isSha256Hex,
  MAX_SAFE_AMOUNT_MINOR,
  serializeCanonicalJson,
  serializeCanonicalJsonl,
  sha256Bytes,
  verifyCanonicalJson,
  verifyCanonicalJsonl,
} from "../src/protocol-records/index.ts";

const UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DIGEST = "a".repeat(64);

test("M0-A#ref1 accepts a lowercase UUIDv4 and rejects other identities", () => {
  assert.equal(isLowercaseUuidV4(UUID), true);
  assert.equal(isLowercaseUuidV4(UUID.toUpperCase()), false);
  assert.equal(isLowercaseUuidV4("not-a-uuid"), false);
  assert.equal(isLowercaseUuidV4(""), false);
  assert.equal(isLowercaseUuidV4(1), false);
});

test("M0-A#silent rejects empty or whitespace-only identifiers", () => {
  assert.equal(isNonemptyTrimmedIdentifier("pay-poc-001"), true);
  assert.equal(isNonemptyTrimmedIdentifier("  pay-poc-001  "), true);
  assert.equal(isNonemptyTrimmedIdentifier(""), false);
  assert.equal(isNonemptyTrimmedIdentifier("   "), false);
  assert.equal(isNonemptyTrimmedIdentifier(null), false);
});

test("M0-A#at accepts a canonical UTC millisecond timestamp", () => {
  assert.equal(isCanonicalUtcMillisecondTimestamp("2026-08-25T17:17:00.000Z"), true);
});

test("M0-A#below rejects timestamps that omit milliseconds or use another offset", () => {
  assert.equal(isCanonicalUtcMillisecondTimestamp("2026-08-25T17:17:00Z"), false);
  assert.equal(isCanonicalUtcMillisecondTimestamp("2026-08-25T17:17:00.000+00:00"), false);
  assert.equal(isCanonicalUtcMillisecondTimestamp("2026-02-31T00:00:00.000Z"), false);
});

test("M0-A#row1 accepts a lowercase record_type", () => {
  assert.equal(isCanonicalRecordType("payment"), true);
  assert.equal(isCanonicalRecordType("approved_decision"), true);
  assert.equal(isCanonicalRecordType("Payment"), false);
  assert.equal(isCanonicalRecordType("1payment"), false);
});

test("M0-A#at accepts a positive safe amount_minor and the PoC fixture", () => {
  assert.equal(isPositiveSafeAmountMinor(10000), true);
  assert.equal(isPositiveSafeAmountMinor(1), true);
  assert.equal(isPositiveSafeAmountMinor(MAX_SAFE_AMOUNT_MINOR), true);
  assert.equal(ALLOWED_CURRENCY, "BRL");
});

test("M0-A#below rejects zero, negative, fractional, unsafe, -0, bigint, and string amounts", () => {
  assert.equal(isPositiveSafeAmountMinor(0), false);
  assert.equal(isPositiveSafeAmountMinor(-1), false);
  assert.equal(isPositiveSafeAmountMinor(10000.5), false);
  assert.equal(isPositiveSafeAmountMinor(MAX_SAFE_AMOUNT_MINOR + 1), false);
  assert.equal(isPositiveSafeAmountMinor(-0), false);
  assert.equal(isPositiveSafeAmountMinor(1n), false);
  assert.equal(isPositiveSafeAmountMinor("10000"), false);
});

test("M0-A#row1 accepts a lowercase SHA-256 hex digest", () => {
  assert.equal(isSha256Hex(DIGEST), true);
  assert.equal(isSha256Hex(DIGEST.toUpperCase()), false);
  assert.equal(isSha256Hex("abc"), false);
});

test("M0-A#refused rejects absolute, parent, and Windows paths", () => {
  assert.equal(isNormalizedRelativePosixPath("ledger/snapshot.json"), true);
  assert.equal(isNormalizedRelativePosixPath("/ledger/snapshot.json"), false);
  assert.equal(isNormalizedRelativePosixPath("../secret"), false);
  assert.equal(isNormalizedRelativePosixPath("foo\\bar"), false);
  assert.equal(isNormalizedRelativePosixPath("C:foo"), false);
  assert.equal(isNormalizedRelativePosixPath(""), false);
});

test("M0-A#at accepts a source_sequence of one and above", () => {
  assert.equal(isPositiveSafeSequence(1), true);
  assert.equal(isPositiveSafeSequence(2), true);
});

test("M0-A#below rejects non-positive or non-integer sequences", () => {
  assert.equal(isPositiveSafeSequence(0), false);
  assert.equal(isPositiveSafeSequence(-1), false);
  assert.equal(isPositiveSafeSequence(1.5), false);
  assert.equal(isPositiveSafeSequence("1"), false);
});

test("M0-A#row1 accepts canonical monotonic nanosecond strings", () => {
  assert.equal(isCanonicalMonotonicNanos("0"), true);
  assert.equal(isCanonicalMonotonicNanos("3000000000"), true);
  assert.equal(isCanonicalMonotonicNanos("00"), false);
  assert.equal(isCanonicalMonotonicNanos("-1"), false);
  assert.equal(isCanonicalMonotonicNanos("1e6"), false);
});

test("M0-A#row1 accepts a JSON pointer that starts with a slash", () => {
  assert.equal(isCanonicalJsonPointer("/"), true);
  assert.equal(isCanonicalJsonPointer("/transactions/0"), true);
  assert.equal(isCanonicalJsonPointer("transactions/0"), false);
  assert.equal(isCanonicalJsonPointer(""), false);
});

test("M0-A#ref1 serializes canonical JSON with sorted keys and a trailing newline", () => {
  const bytes = serializeCanonicalJson({
    record_type: "payment",
    schema_version: 1,
    currency: "BRL",
  });
  assert.equal(
    bytes,
    `${JSON.stringify(
      {
        currency: "BRL",
        record_type: "payment",
        schema_version: 1,
      },
      null,
      2,
    )}\n`,
  );
});

test("M0-A#ref1 produces the same SHA-256 digest across repeated canonical serializations", () => {
  const value = { schema_version: 1, record_type: "payment", payment_id: "pay-poc-001" };
  const first = serializeCanonicalJson(value);
  const second = serializeCanonicalJson(value);
  assert.equal(first, second);
  assert.equal(sha256Bytes(first), sha256Bytes(second));
  assert.match(sha256Bytes(first), /^[0-9a-f]{64}$/);
});

test("M0-A#refused rejects JSON bytes that are not in canonical form", () => {
  const result = verifyCanonicalJson('{"schema_version":1}\n');
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected rejection");
  }
  assert.equal(result.reasons[0]?.code, "bytes_not_canonical");
});

test("M0-A#ref1 verifies canonical JSON bytes and an exact digest", () => {
  const bytes = serializeCanonicalJson({ schema_version: 1, record_type: "payment" });
  const digest = sha256Bytes(bytes);
  const result = verifyCanonicalJson(bytes, digest);
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("expected verification");
  }
  assert.equal(result.value.sha256, digest);
});

test("M0-A#refused rejects a digest that does not match the stored bytes", () => {
  const bytes = serializeCanonicalJson({ schema_version: 1, record_type: "payment" });
  const result = verifyCanonicalJson(bytes, DIGEST);
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected rejection");
  }
  assert.equal(result.reasons[0]?.code, "digest_mismatch");
});

test("M0-A#ref1 serializes JSONL as compact sorted lines with a trailing newline", () => {
  const bytes = serializeCanonicalJsonl([
    { record_type: "payment", schema_version: 1 },
    { record_type: "approved_decision", schema_version: 1 },
  ]);
  assert.equal(
    bytes,
    '{"record_type":"payment","schema_version":1}\n{"record_type":"approved_decision","schema_version":1}\n',
  );
  const again = serializeCanonicalJsonl([
    { record_type: "payment", schema_version: 1 },
    { record_type: "approved_decision", schema_version: 1 },
  ]);
  assert.equal(sha256Bytes(bytes), sha256Bytes(again));
});

test("M0-A#refused rejects JSONL that is pretty-printed or missing a trailing newline", () => {
  const pretty = verifyCanonicalJsonl(
    `${JSON.stringify({ schema_version: 1, record_type: "payment" }, null, 2)}\n`,
  );
  assert.equal(pretty.ok, false);
  const missingNewline = verifyCanonicalJsonl('{"record_type":"payment","schema_version":1}');
  assert.equal(missingNewline.ok, false);
  if (missingNewline.ok) {
    throw new Error("expected rejection");
  }
  assert.equal(missingNewline.reasons[0]?.code, "jsonl_missing_trailing_newline");
});

test("M0-A#ref1 verifies empty JSONL as an empty record set", () => {
  const result = verifyCanonicalJsonl("");
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("expected verification");
  }
  assert.deepEqual(result.value.values, []);
  assert.equal(result.value.sha256, sha256Bytes(""));
});

const PAYMENT_FIXTURE = {
  schema_version: 1,
  record_type: "payment",
  payment_id: "pay-poc-001",
  captured_amount_minor: 10000,
  currency: "BRL",
};

const DECISION_FIXTURE = {
  schema_version: 1,
  record_type: "approved_decision",
  refund_request_id: "ref-poc-001",
  payment_id: "pay-poc-001",
  decision: "APPROVED",
  approved_amount_minor: 10000,
  currency: "BRL",
};

function reasonCodes(result: { ok: false; reasons: Array<{ code: string }> }): string[] {
  return result.reasons.map((reason) => reason.code);
}

test("M0-A#ref1 creates the payment fixture and trims identifiers", () => {
  const created = createPayment({ ...PAYMENT_FIXTURE, payment_id: "  pay-poc-001  " });
  assert.equal(created.ok, true);
  if (!created.ok) {
    throw new Error("expected payment");
  }
  assert.deepEqual(created.value, PAYMENT_FIXTURE);
});

test("M0-A#refused rejects invalid payment schema, amount, currency, and unknown fields", () => {
  const cases: Array<{ name: string; input: unknown; code: string }> = [
    { name: "not an object", input: [], code: "not_an_object" },
    { name: "schema", input: { ...PAYMENT_FIXTURE, schema_version: 2 }, code: "invalid_schema_version" },
    { name: "type", input: { ...PAYMENT_FIXTURE, record_type: "refund" }, code: "invalid_record_type" },
    { name: "empty id", input: { ...PAYMENT_FIXTURE, payment_id: "  " }, code: "identifier_empty" },
    { name: "zero amount", input: { ...PAYMENT_FIXTURE, captured_amount_minor: 0 }, code: "invalid_amount_minor" },
    { name: "USD", input: { ...PAYMENT_FIXTURE, currency: "USD" }, code: "invalid_currency" },
    { name: "unknown field", input: { ...PAYMENT_FIXTURE, extra: true }, code: "unknown_property" },
  ];
  for (const row of cases) {
    const result = createPayment(row.input);
    assert.equal(result.ok, false, row.name);
    if (result.ok) {
      throw new Error(row.name);
    }
    assert.ok(reasonCodes(result).includes(row.code), row.name);
  }
});

test("M0-A#ref1 creates the approved decision fixture", () => {
  const created = createApprovedDecision(DECISION_FIXTURE);
  assert.equal(created.ok, true);
  if (!created.ok) {
    throw new Error("expected decision");
  }
  assert.deepEqual(created.value, DECISION_FIXTURE);
});

test("M0-A#refused rejects an unapproved decision and unknown decision fields", () => {
  const denied = createApprovedDecision({ ...DECISION_FIXTURE, decision: "DENIED" });
  assert.equal(denied.ok, false);
  if (denied.ok) {
    throw new Error("expected rejection");
  }
  assert.ok(reasonCodes(denied).includes("decision_not_approved"));
  const extra = createApprovedDecision({ ...DECISION_FIXTURE, note: "x" });
  assert.equal(extra.ok, false);
  if (extra.ok) {
    throw new Error("expected rejection");
  }
  assert.ok(reasonCodes(extra).includes("unknown_property"));
});

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SOURCE_INSTANCE = "22222222-2222-4222-8222-222222222222";
const CAUSE_ID = "33333333-3333-4333-8333-333333333333";
const MANIFEST = "c".repeat(64);

function rootEvent() {
  return {
    schema_version: 1,
    record_type: "dispatch_started",
    event_id: EVENT_ID,
    occurred_at: "2026-08-25T17:17:00.000Z",
    source: "caller",
    source_instance_id: SOURCE_INSTANCE,
    source_sequence: 1,
    trial_manifest_sha256: MANIFEST,
    run_id: RUN_ID,
  };
}

test("M0-A#ref1 creates a root primary event and keeps extra correlation fields", () => {
  const created = createPrimaryEvent({ ...rootEvent(), payment_id: "pay-poc-001" });
  assert.equal(created.ok, true);
  if (!created.ok) {
    throw new Error("expected event");
  }
  assert.equal(created.value.causation_event_ids, undefined);
  assert.equal(created.value.payment_id, "pay-poc-001");
});

test("M0-A#refused rejects missing, dual, or invalid execution identity on an event", () => {
  const missing = createPrimaryEvent({ ...rootEvent(), run_id: undefined });
  assert.equal(missing.ok, false);
  const dual = createPrimaryEvent({
    ...rootEvent(),
    transport_probe_id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
  });
  assert.equal(dual.ok, false);
  if (dual.ok) {
    throw new Error("expected rejection");
  }
  assert.ok(reasonCodes(dual).includes("invalid_execution_identity"));
});

test("M0-A#refused rejects empty, unsorted, or invalid causation_event_ids", () => {
  const empty = createPrimaryEvent({ ...rootEvent(), causation_event_ids: [] });
  assert.equal(empty.ok, false);
  const unsorted = createPrimaryEvent({
    ...rootEvent(),
    causation_event_ids: [CAUSE_ID, EVENT_ID],
  });
  assert.equal(unsorted.ok, false);
  if (unsorted.ok) {
    throw new Error("expected rejection");
  }
  assert.ok(reasonCodes(unsorted).includes("unsorted_causation_event_ids"));
  const invalid = createPrimaryEvent({
    ...rootEvent(),
    causation_event_ids: ["not-a-uuid"],
  });
  assert.equal(invalid.ok, false);
});

test("M0-A#ref1 accepts sorted unique causation predecessors", () => {
  const created = createPrimaryEvent({
    ...rootEvent(),
    event_id: CAUSE_ID,
    source_sequence: 2,
    causation_event_ids: [EVENT_ID, "44444444-4444-4444-8444-444444444444"].toSorted(),
  });
  assert.equal(created.ok, true);
});

test("M0-A#ref1 sorts evidence_refs and rejects aliases and duplicates", () => {
  const created = createEvidenceRefs([
    {
      artifact_path: "ledger/snapshot.json",
      artifact_sha256: "b".repeat(64),
      json_pointer: "/transactions/0",
    },
    {
      artifact_path: "events/caller.jsonl",
      artifact_sha256: "a".repeat(64),
      event_id: EVENT_ID,
    },
  ]);
  assert.equal(created.ok, true);
  if (!created.ok) {
    throw new Error("expected refs");
  }
  assert.equal(created.value[0]?.artifact_path, "events/caller.jsonl");
  assert.equal(created.value[1]?.artifact_path, "ledger/snapshot.json");

  const aliased = createEvidenceRefs({ evidence: [] });
  assert.equal(aliased.ok, false);
  if (aliased.ok) {
    throw new Error("expected rejection");
  }
  assert.ok(reasonCodes(aliased).includes("rejected_alias"));

  const duplicate = createEvidenceRefs([
    { artifact_path: "ledger/snapshot.json", artifact_sha256: "a".repeat(64) },
    { artifact_path: "ledger/snapshot.json", artifact_sha256: "b".repeat(64) },
  ]);
  assert.equal(duplicate.ok, false);
  if (duplicate.ok) {
    throw new Error("expected rejection");
  }
  assert.ok(reasonCodes(duplicate).includes("duplicate_evidence_ref"));
});

test("M0-A#refused rejects an absolute evidence path and a missing package index when required", () => {
  const absolute = createEvidenceRefs([
    { artifact_path: "/tmp/ledger.json", artifact_sha256: "a".repeat(64) },
  ]);
  assert.equal(absolute.ok, false);
  const missingIndex = createEvidenceRefs(
    [{ artifact_path: "ledger/snapshot.json", artifact_sha256: "a".repeat(64) }],
    { requirePackageIndex: true },
  );
  assert.equal(missingIndex.ok, false);
  if (missingIndex.ok) {
    throw new Error("expected rejection");
  }
  assert.ok(reasonCodes(missingIndex).includes("missing_package_index_sha256"));
});

test("M0-A#row1 classifies equivalent event_id repeats as duplicates", () => {
  const event = rootEvent();
  const result = classifyEventSequence([event, event]);
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("expected classification");
  }
  assert.deepEqual(result.value.duplicate_event_ids, [{ event_id: EVENT_ID, count: 2 }]);
});

test("M0-A#refused rejects event_id conflicts, sequence conflicts, and density gaps", () => {
  const event = rootEvent();
  const conflict = classifyEventSequence([event, { ...event, source_sequence: 2 }]);
  assert.equal(conflict.ok, false);
  if (conflict.ok) {
    throw new Error("expected rejection");
  }
  assert.ok(reasonCodes(conflict).includes("event_id_conflict"));

  const slot = classifyEventSequence([
    event,
    { ...event, event_id: CAUSE_ID, record_type: "other" },
  ]);
  assert.equal(slot.ok, false);
  if (slot.ok) {
    throw new Error("expected rejection");
  }
  assert.ok(reasonCodes(slot).includes("source_sequence_conflict"));

  const gap = classifyEventSequence([
    event,
    { ...event, event_id: CAUSE_ID, source_sequence: 3 },
  ]);
  assert.equal(gap.ok, false);
  if (gap.ok) {
    throw new Error("expected rejection");
  }
  assert.ok(reasonCodes(gap).includes("source_sequence_gap"));
});
