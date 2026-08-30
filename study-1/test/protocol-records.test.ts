import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyEventSequence,
  createApprovedDecision,
  createEvidenceRefs,
  createPayment,
  createPrimaryEvent,
  serializeCanonicalJson,
  serializeCanonicalJsonl,
  sha256Hex,
  verifyCanonicalBytes,
  verifyDigest,
} from "../src/protocol-records/index.ts";
import { structuralKey } from "../src/protocol-records/serialize.ts";

const DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_INSTANCE = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const PROBE_ID = "44444444-4444-4444-8444-444444444444";
const VALIDATION_ID = "55555555-5555-4555-8555-555555555555";
const CAUSE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAUSE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const PAYMENT = {
  schema_version: 1,
  record_type: "payment",
  payment_id: "pay-poc-001",
  captured_amount_minor: 10000,
  currency: "BRL",
};

const DECISION = {
  schema_version: 1,
  record_type: "approved_decision",
  refund_request_id: "ref-poc-001",
  payment_id: "pay-poc-001",
  decision: "APPROVED",
  approved_amount_minor: 10000,
  currency: "BRL",
};

function event(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    record_type: "caller_journal",
    event_id: EVENT_ID,
    occurred_at: "2026-08-29T12:00:00.000Z",
    source: "runner",
    source_instance_id: SOURCE_INSTANCE,
    source_sequence: 1,
    run_id: RUN_ID,
    trial_manifest_sha256: DIGEST,
    ...overrides,
  };
}

describe("payment records", () => {
  it("accepts the spec payment fixture and trims identity", () => {
    const created = createPayment({ ...PAYMENT, payment_id: "  pay-poc-001  " });
    assert.equal(created.ok, true);
    if (created.ok) {
      assert.deepEqual(created.value, PAYMENT);
    }
  });

  it("rejects invalid payment values", () => {
    const cases: Array<[unknown, string]> = [
      [null, "not_an_object"],
      [[], "not_an_object"],
      [{ ...PAYMENT, extra: true }, "unknown_property"],
      [{ ...PAYMENT, evidence: [] }, "alias_rejected"],
      [{ ...PAYMENT, schema_version: 2 }, "invalid_schema_version"],
      [{ ...PAYMENT, record_type: "PAYMENT" }, "invalid_record_type"],
      [{ ...PAYMENT, payment_id: "" }, "empty_identity"],
      [{ ...PAYMENT, payment_id: "   " }, "empty_identity"],
      [{ ...PAYMENT, payment_id: 1 }, "invalid_identifier"],
      [{ ...PAYMENT, captured_amount_minor: 0 }, "invalid_amount"],
      [{ ...PAYMENT, captured_amount_minor: -1 }, "invalid_amount"],
      [{ ...PAYMENT, captured_amount_minor: -0 }, "invalid_amount"],
      [{ ...PAYMENT, captured_amount_minor: 1.5 }, "invalid_amount"],
      [{ ...PAYMENT, captured_amount_minor: Number.MAX_SAFE_INTEGER + 1 }, "invalid_amount"],
      [{ ...PAYMENT, currency: "USD" }, "invalid_currency"],
    ];
    for (const [input, reason] of cases) {
      const created = createPayment(input);
      assert.equal(created.ok, false, String(reason));
      if (!created.ok) {
        assert.ok(created.reasons.includes(reason), `${reason} in ${created.reasons.join(",")}`);
      }
    }
  });
});

describe("approved decision records", () => {
  it("accepts the spec approved-decision fixture", () => {
    const created = createApprovedDecision(DECISION);
    assert.equal(created.ok, true);
    if (created.ok) {
      assert.deepEqual(created.value, DECISION);
    }
  });

  it("rejects invalid approved decisions without pairing against a payment", () => {
    const created = createApprovedDecision({ ...DECISION, approved_amount_minor: 1 });
    assert.equal(created.ok, true);
    const rejected = createApprovedDecision({ ...DECISION, decision: "DENIED" });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.ok(rejected.reasons.includes("invalid_decision"));
    }
    assert.equal(createApprovedDecision(null).ok, false);
    assert.equal(createApprovedDecision({ ...DECISION, extra: 1 }).ok, false);
    assert.equal(createApprovedDecision({ ...DECISION, refund_request_id: "" }).ok, false);
  });
});

describe("evidence references", () => {
  it("sorts refs and rejects aliases, paths, and duplicates", () => {
    const created = createEvidenceRefs([
      { artifact_path: "z/b.json", artifact_sha256: DIGEST, json_pointer: "/b" },
      { artifact_path: "a/a.json", artifact_sha256: DIGEST, event_id: EVENT_ID },
    ]);
    assert.equal(created.ok, true);
    if (created.ok) {
      assert.equal(created.value[0]?.artifact_path, "a/a.json");
      assert.equal(created.value[1]?.artifact_path, "z/b.json");
    }
    const duplicate = createEvidenceRefs([
      { artifact_path: "a.json", artifact_sha256: DIGEST },
      { artifact_path: "a.json", artifact_sha256: DIGEST },
    ]);
    assert.equal(duplicate.ok, false);
    const cases: Array<[unknown, string]> = [
      [{ artifact_path: "/abs.json", artifact_sha256: DIGEST }, "invalid_path"],
      [{ artifact_path: "../x.json", artifact_sha256: DIGEST }, "invalid_path"],
      [{ artifact_path: "a/./b.json", artifact_sha256: DIGEST }, "invalid_path"],
      [{ artifact_path: "a.json", artifact_sha256: "zz" }, "invalid_sha256"],
      [{ artifact_path: "a.json", artifact_sha256: DIGEST, event_id: "nope" }, "invalid_uuid"],
      [{ artifact_path: "a.json", artifact_sha256: DIGEST, json_pointer: "foo" }, "invalid_json_pointer"],
      [{ artifact_path: "a.json", artifact_sha256: DIGEST, references: [] }, "alias_rejected"],
    ];
    for (const [input, reason] of cases) {
      const result = createEvidenceRefs([input]);
      assert.equal(result.ok, false, reason);
      if (!result.ok) {
        assert.ok(result.reasons.includes(reason));
      }
    }
    assert.equal(createEvidenceRefs(null).ok, false);
    const withPointer = createEvidenceRefs([
      { artifact_path: "a.json", artifact_sha256: DIGEST, json_pointer: "" },
      { artifact_path: "a.json", artifact_sha256: DIGEST, json_pointer: "/x", package_index_sha256: DIGEST },
    ]);
    assert.equal(withPointer.ok, true);
  });
});

describe("primary events", () => {
  it("accepts one execution binding and sorts causation", () => {
    const created = createPrimaryEvent(event({
      causation_event_ids: [CAUSE_B, CAUSE_A],
      correlation_id: "corr-1",
    }));
    assert.equal(created.ok, true);
    if (created.ok) {
      assert.deepEqual(created.value.causation_event_ids, [CAUSE_A, CAUSE_B]);
      assert.equal(created.value.correlation_id, "corr-1");
      assert.equal(created.value.run_id, RUN_ID);
    }
  });

  it("accepts transport-probe and variant-validation bindings", () => {
    const probe = createPrimaryEvent(event({ run_id: undefined, transport_probe_id: PROBE_ID }));
    const validation = createPrimaryEvent(event({
      run_id: undefined,
      variant_validation_id: VALIDATION_ID,
    }));
    assert.equal(probe.ok, true);
    assert.equal(validation.ok, true);
  });

  it("rejects invalid event envelopes", () => {
    const cases: Array<[unknown, string]> = [
      [event({ run_id: undefined }), "missing_execution_binding"],
      [event({ transport_probe_id: PROBE_ID }), "ambiguous_execution_binding"],
      [event({ occurred_at: "2026-08-29T12:00:00Z" }), "invalid_timestamp"],
      [event({ occurred_at: "2026-02-30T12:00:00.000Z" }), "invalid_timestamp"],
      [event({ event_id: "not-a-uuid" }), "invalid_uuid"],
      [event({ source_sequence: 0 }), "invalid_sequence"],
      [event({ source: "  " }), "empty_identity"],
      [event({ record_type: "CallerJournal" }), "invalid_record_type"],
      [event({ causation_event_ids: [CAUSE_A, CAUSE_A] }), "invalid_causation"],
      [event({ evidence: [] }), "alias_rejected"],
    ];
    for (const [input, reason] of cases) {
      const created = createPrimaryEvent(input);
      assert.equal(created.ok, false, reason);
      if (!created.ok) {
        assert.ok(created.reasons.includes(reason), `${reason} in ${created.reasons.join(",")}`);
      }
    }
  });
});

describe("event sequences", () => {
  it("reports duplicates, conflicts, gaps, and missing causation", () => {
    const duplicate = classifyEventSequence([event(), event()]);
    assert.equal(duplicate.ok, true);
    if (duplicate.ok) {
      assert.equal(duplicate.value.equivalent_duplicates, 1);
    }
    const conflict = classifyEventSequence([
      event(),
      event({ source: "other" }),
      event({ source: "third" }),
    ]);
    assert.equal(conflict.ok, true);
    if (conflict.ok) {
      assert.ok(conflict.value.content_conflicts.includes(EVENT_ID));
    }
    const gap = classifyEventSequence([
      event(),
      event({ event_id: CAUSE_B, source_sequence: 3 }),
    ]);
    assert.equal(gap.ok, true);
    if (gap.ok) {
      assert.ok(gap.value.gaps.some((item) => item.endsWith("\n2")));
    }
    const missing = classifyEventSequence([
      event({ causation_event_ids: [PROBE_ID] }),
    ]);
    assert.equal(missing.ok, true);
    if (missing.ok) {
      assert.deepEqual(missing.value.missing_causation, [PROBE_ID]);
    }
    const sequenceConflict = classifyEventSequence([
      event(),
      event({ event_id: CAUSE_A }),
    ]);
    assert.equal(sequenceConflict.ok, true);
    if (sequenceConflict.ok) {
      assert.equal(sequenceConflict.value.sequence_conflicts.length, 1);
    }
    assert.equal(classifyEventSequence(null).ok, false);
    assert.equal(classifyEventSequence([event({ event_id: "bad" })]).ok, false);
    assert.equal(classifyEventSequence([event({ extra: 1n })]).ok, false);
  });
});

describe("canonical bytes and digests", () => {
  it("pretty-prints sorted JSON and compact JSONL", () => {
    const proto = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(proto, "__proto__", {
      configurable: true,
      enumerable: true,
      value: "keep",
      writable: true,
    });
    proto.b = 2;
    proto.a = 1;
    const json = serializeCanonicalJson(proto);
    assert.equal(json.ok, true);
    if (json.ok) {
      assert.equal(json.value, "{\n  \"__proto__\": \"keep\",\n  \"a\": 1,\n  \"b\": 2\n}\n");
    }
    const jsonl = serializeCanonicalJsonl([PAYMENT, DECISION]);
    assert.equal(jsonl.ok, true);
    if (jsonl.ok) {
      assert.equal(jsonl.value.endsWith("\n"), true);
      assert.equal(jsonl.value.includes("\n  "), false);
    }
  });

  it("verifies exact bytes and lowercase SHA-256", () => {
    const serialized = serializeCanonicalJson(PAYMENT);
    assert.equal(serialized.ok, true);
    if (!serialized.ok) {
      return;
    }
    const matched = verifyCanonicalBytes(PAYMENT, serialized.value);
    assert.equal(matched.ok, true);
    const mismatched = verifyCanonicalBytes(PAYMENT, "{}\n");
    assert.equal(mismatched.ok, false);
    const digest = sha256Hex(serialized.value);
    assert.equal(verifyDigest(serialized.value, digest).ok, true);
    assert.equal(verifyDigest(serialized.value, DIGEST).ok, false);
    assert.equal(verifyDigest(serialized.value, "zz").ok, false);
  });

  it("rejects unserializable values", () => {
    assert.equal(serializeCanonicalJson(undefined).ok, false);
    assert.equal(serializeCanonicalJson(1n).ok, false);
    assert.equal(serializeCanonicalJson(Symbol("x")).ok, false);
    assert.equal(serializeCanonicalJson(() => 1).ok, false);
    assert.equal(serializeCanonicalJsonl([1n]).ok, false);
    assert.equal(serializeCanonicalJsonl([undefined]).ok, false);
    assert.equal(serializeCanonicalJson({ when: new Date("2026-01-01T00:00:00.000Z") }).ok, false);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.equal(serializeCanonicalJson(circular).ok, false);
    const circularArray: unknown[] = [];
    circularArray.push(circularArray);
    assert.equal(serializeCanonicalJson(circularArray).ok, false);
    assert.equal(serializeCanonicalJson([undefined]).ok, false);
    const omitted = serializeCanonicalJson({ b: 1, a: undefined });
    assert.equal(omitted.ok, true);
    if (omitted.ok) {
      assert.equal(omitted.value, "{\n  \"b\": 1\n}\n");
    }
    const emptyLines = serializeCanonicalJsonl([]);
    assert.equal(emptyLines.ok, true);
    if (emptyLines.ok) {
      assert.equal(emptyLines.value, "\n");
    }
    assert.equal(verifyCanonicalBytes(1n, "{}\n").ok, false);
    assert.equal(createPrimaryEvent(event({ run_id: "not-uuid" })).ok, false);
    assert.equal(createPrimaryEvent(event({ causation_event_ids: "nope" })).ok, false);
    assert.equal(createPrimaryEvent(event({ causation_event_ids: [] })).ok, true);
    assert.equal(createPrimaryEvent(event({ source: 1 })).ok, false);
    assert.equal(createPrimaryEvent(null).ok, false);
    assert.equal(createPrimaryEvent(event({ schema_version: 2 })).ok, false);
    assert.equal(createPrimaryEvent(event({ occurred_at: 1 })).ok, false);
    assert.equal(createPrimaryEvent(event({ source_instance_id: "nope" })).ok, false);
    assert.equal(createPrimaryEvent(event({ trial_manifest_sha256: "nope" })).ok, false);
    assert.equal(createEvidenceRefs([null]).ok, false);
    assert.equal(createEvidenceRefs([{ artifact_path: "a.json/", artifact_sha256: DIGEST }]).ok, false);
    assert.equal(createEvidenceRefs([{ artifact_path: "C:a.json", artifact_sha256: DIGEST }]).ok, false);
    assert.equal(createEvidenceRefs([{ artifact_path: "a.json", artifact_sha256: DIGEST, package_index_sha256: "nope" }]).ok, false);
    const ordered = createEvidenceRefs([
      { artifact_path: "same.json", artifact_sha256: DIGEST, json_pointer: "/b", event_id: CAUSE_B },
      { artifact_path: "same.json", artifact_sha256: DIGEST, json_pointer: "/a", event_id: CAUSE_A },
      { artifact_path: "same.json", artifact_sha256: DIGEST, json_pointer: "/c" },
    ]);
    assert.equal(ordered.ok, true);
    if (ordered.ok) {
      assert.equal(ordered.value[0]?.event_id, undefined);
      assert.equal(ordered.value[1]?.event_id, CAUSE_A);
    }
    const packages = createEvidenceRefs([
      { artifact_path: "q.json", artifact_sha256: DIGEST, json_pointer: "/b", package_index_sha256: sha256Hex("b") },
      { artifact_path: "q.json", artifact_sha256: DIGEST, json_pointer: "/a", package_index_sha256: sha256Hex("a") },
      { artifact_path: "q.json", artifact_sha256: DIGEST, json_pointer: "/c" },
    ]);
    assert.equal(packages.ok, true);
    const equalIds = createEvidenceRefs([
      { artifact_path: "e.json", artifact_sha256: DIGEST, json_pointer: "/b", event_id: CAUSE_A },
      { artifact_path: "e.json", artifact_sha256: DIGEST, json_pointer: "/a", event_id: CAUSE_A },
    ]);
    assert.equal(equalIds.ok, true);
    assert.equal(structuralKey(1n).ok, false);
    assert.equal(sha256Hex(new Uint8Array()).length, 64);
    assert.equal(createEvidenceRefs([{ artifact_path: "a\\b.json", artifact_sha256: DIGEST }]).ok, false);
    assert.equal(createEvidenceRefs([{ artifact_path: "a//b.json", artifact_sha256: DIGEST }]).ok, false);
  });
});
