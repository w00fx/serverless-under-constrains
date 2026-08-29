import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALLOWED_CURRENCY,
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
