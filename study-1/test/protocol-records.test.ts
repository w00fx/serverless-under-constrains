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
import type { EventSequenceReport, ValidationResult } from "../src/protocol-records/types.ts";

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

function assertRejected(result: ValidationResult<unknown>, ...expected: string[]): void {
  assert.equal(result.ok, false, expected.join(","));
  if (result.ok) {
    return;
  }
  assert.deepEqual([...result.reasons].toSorted(), [...expected].toSorted());
}

function assertAccepted<T>(result: ValidationResult<T>): T {
  assert.equal(result.ok, true);
  if (result.ok) {
    return result.value;
  }
  throw new Error("expected accept");
}

function emptyReport(): EventSequenceReport {
  return {
    equivalent_duplicates: 0,
    content_conflicts: [],
    sequence_conflicts: [],
    gaps: [],
    missing_causation: [],
  };
}

describe("payment records", () => {
  it("accepts the spec payment fixture and trims identity", () => {
    const created = assertAccepted(createPayment({ ...PAYMENT, payment_id: "  pay-poc-001  " }));
    assert.deepEqual(created, PAYMENT);
  });

  it("rejects invalid payment values with exact reasons", () => {
    const cases: Array<[unknown, string[]]> = [
      [null, ["not_an_object"]],
      [[], ["not_an_object"]],
      [1, ["not_an_object"]],
      ["payment", ["not_an_object"]],
      [{ ...PAYMENT, extra: true }, ["unknown_property"]],
      [{ ...PAYMENT, evidence: [] }, ["alias_rejected"]],
      [{ ...PAYMENT, references: [] }, ["alias_rejected"]],
      [{ ...PAYMENT, evidence_references: [] }, ["alias_rejected"]],
      [{ ...PAYMENT, schema_version: 2 }, ["invalid_schema_version"]],
      [{ ...PAYMENT, record_type: "PAYMENT" }, ["invalid_record_type"]],
      [{ ...PAYMENT, payment_id: "" }, ["empty_identity"]],
      [{ ...PAYMENT, payment_id: "   " }, ["empty_identity"]],
      [{ ...PAYMENT, payment_id: 1 }, ["invalid_identifier"]],
      [{ ...PAYMENT, captured_amount_minor: 0 }, ["invalid_amount"]],
      [{ ...PAYMENT, captured_amount_minor: -1 }, ["invalid_amount"]],
      [{ ...PAYMENT, captured_amount_minor: -0 }, ["invalid_amount"]],
      [{ ...PAYMENT, captured_amount_minor: 1.5 }, ["invalid_amount"]],
      [{ ...PAYMENT, captured_amount_minor: Number.MAX_SAFE_INTEGER + 1 }, ["invalid_amount"]],
      [{ ...PAYMENT, captured_amount_minor: true }, ["invalid_amount"]],
      [{ ...PAYMENT, currency: "USD" }, ["invalid_currency"]],
    ];
    for (const [input, reasons] of cases) {
      assertRejected(createPayment(input), ...reasons);
    }
  });
});

describe("approved decision records", () => {
  it("accepts the spec approved-decision fixture without pairing against a payment", () => {
    assert.deepEqual(assertAccepted(createApprovedDecision(DECISION)), DECISION);
    assert.deepEqual(
      assertAccepted(createApprovedDecision({ ...DECISION, approved_amount_minor: 1 })),
      { ...DECISION, approved_amount_minor: 1 },
    );
  });

  it("rejects invalid approved decisions with exact reasons", () => {
    assertRejected(createApprovedDecision(null), "not_an_object");
    assertRejected(createApprovedDecision([]), "not_an_object");
    assertRejected(createApprovedDecision({ ...DECISION, extra: 1 }), "unknown_property");
    assertRejected(createApprovedDecision({ ...DECISION, evidence: [] }), "alias_rejected");
    assertRejected(createApprovedDecision({ ...DECISION, evidence_references: [] }), "alias_rejected");
    assertRejected(createApprovedDecision({ ...DECISION, references: [] }), "alias_rejected");
    assertRejected(createApprovedDecision({ ...DECISION, schema_version: 2 }), "invalid_schema_version");
    assertRejected(createApprovedDecision({ ...DECISION, record_type: "decision" }), "invalid_record_type");
    assertRejected(createApprovedDecision({ ...DECISION, refund_request_id: "" }), "empty_identity");
    assertRejected(createApprovedDecision({ ...DECISION, refund_request_id: 1 }), "invalid_identifier");
    assertRejected(createApprovedDecision({ ...DECISION, payment_id: "" }), "empty_identity");
    assertRejected(createApprovedDecision({ ...DECISION, payment_id: 1 }), "invalid_identifier");
    assertRejected(createApprovedDecision({ ...DECISION, decision: "DENIED" }), "invalid_decision");
    assertRejected(createApprovedDecision({ ...DECISION, approved_amount_minor: 0 }), "invalid_amount");
    assertRejected(createApprovedDecision({ ...DECISION, currency: "USD" }), "invalid_currency");
  });
});

describe("evidence references", () => {
  it("sorts refs by path, then optional event, pointer, and package digest", () => {
    const created = assertAccepted(createEvidenceRefs([
      { artifact_path: "z/b.json", artifact_sha256: DIGEST, json_pointer: "/b" },
      { artifact_path: "m/m.json", artifact_sha256: DIGEST },
      { artifact_path: "a/a.json", artifact_sha256: DIGEST, event_id: EVENT_ID },
    ]));
    assert.deepEqual(created.map((ref) => ref.artifact_path), ["a/a.json", "m/m.json", "z/b.json"]);
    assert.equal("json_pointer" in created[1]!, false);
    assert.equal("event_id" in created[1]!, false);

    const optionalOrder = assertAccepted(createEvidenceRefs([
      { artifact_path: "same.json", artifact_sha256: DIGEST, json_pointer: "/b", event_id: CAUSE_B },
      { artifact_path: "same.json", artifact_sha256: DIGEST, json_pointer: "/a", event_id: CAUSE_A },
      { artifact_path: "same.json", artifact_sha256: DIGEST, json_pointer: "/c" },
    ]));
    assert.deepEqual(optionalOrder.map((ref) => [ref.event_id, ref.json_pointer]), [
      [undefined, "/c"],
      [CAUSE_A, "/a"],
      [CAUSE_B, "/b"],
    ]);

    const equalIds = assertAccepted(createEvidenceRefs([
      { artifact_path: "e.json", artifact_sha256: DIGEST, json_pointer: "/b", event_id: CAUSE_A },
      { artifact_path: "e.json", artifact_sha256: DIGEST, json_pointer: "/a", event_id: CAUSE_A },
    ]));
    assert.deepEqual(equalIds.map((ref) => ref.json_pointer), ["/a", "/b"]);

    const missingPointerFirst = assertAccepted(createEvidenceRefs([
      { artifact_path: "p.json", artifact_sha256: DIGEST, json_pointer: "/a" },
      { artifact_path: "p.json", artifact_sha256: DIGEST },
    ]));
    assert.deepEqual(missingPointerFirst.map((ref) => ref.json_pointer), [undefined, "/a"]);

    const packages = assertAccepted(createEvidenceRefs([
      { artifact_path: "q.json", artifact_sha256: DIGEST, json_pointer: "/b", package_index_sha256: sha256Hex("b") },
      { artifact_path: "q.json", artifact_sha256: DIGEST, json_pointer: "/a", package_index_sha256: sha256Hex("a") },
      { artifact_path: "q.json", artifact_sha256: DIGEST, json_pointer: "/c" },
    ]));
    assert.deepEqual(packages.map((ref) => [ref.json_pointer, ref.package_index_sha256]), [
      ["/a", sha256Hex("a")],
      ["/b", sha256Hex("b")],
      ["/c", undefined],
    ]);
    assert.equal("event_id" in packages[2]!, false);
    assert.equal("package_index_sha256" in packages[2]!, false);
  });

  it("keeps refs distinct when a path and a pointer share separator characters", () => {
    const created = assertAccepted(createEvidenceRefs([
      { artifact_path: "a\n/x", artifact_sha256: DIGEST, json_pointer: "/y" },
      { artifact_path: "a", artifact_sha256: DIGEST, json_pointer: "/x\n/y" },
    ]));
    assert.equal(created.length, 2);
  });

  it("treats a missing pointer and an empty pointer as the same duplicate key", () => {
    assertRejected(
      createEvidenceRefs([
        { artifact_path: "a.json", artifact_sha256: DIGEST },
        { artifact_path: "a.json", artifact_sha256: DIGEST, json_pointer: "" },
      ]),
      "duplicate_evidence_ref",
    );
  });

  it("rejects aliases, paths, hashes, and non-objects with exact reasons", () => {
    assertRejected(
      createEvidenceRefs([
        { artifact_path: "a.json", artifact_sha256: DIGEST },
        { artifact_path: "a.json", artifact_sha256: DIGEST },
      ]),
      "duplicate_evidence_ref",
    );
    const cases: Array<[unknown, string[]]> = [
      [{ artifact_path: "/abs.json", artifact_sha256: DIGEST }, ["invalid_path"]],
      [{ artifact_path: "../x.json", artifact_sha256: DIGEST }, ["invalid_path"]],
      [{ artifact_path: "a/./b.json", artifact_sha256: DIGEST }, ["invalid_path"]],
      [{ artifact_path: ".", artifact_sha256: DIGEST }, ["invalid_path"]],
      [{ artifact_path: "..", artifact_sha256: DIGEST }, ["invalid_path"]],
      [{ artifact_path: "", artifact_sha256: DIGEST }, ["invalid_path"]],
      [{ artifact_path: "a.json/", artifact_sha256: DIGEST }, ["invalid_path"]],
      [{ artifact_path: "C:a.json", artifact_sha256: DIGEST }, ["invalid_path"]],
      [{ artifact_path: "a\\b.json", artifact_sha256: DIGEST }, ["invalid_path"]],
      [{ artifact_path: "a//b.json", artifact_sha256: DIGEST }, ["invalid_path"]],
      [{ artifact_path: 1, artifact_sha256: DIGEST }, ["invalid_path"]],
      [{ artifact_path: "a.json", artifact_sha256: "zz" }, ["invalid_sha256"]],
      [{ artifact_path: "a.json", artifact_sha256: { toString: () => DIGEST } }, ["invalid_sha256"]],
      [{ artifact_path: "a.json", artifact_sha256: DIGEST, event_id: "nope" }, ["invalid_uuid"]],
      [{ artifact_path: "a.json", artifact_sha256: DIGEST, json_pointer: "foo" }, ["invalid_json_pointer"]],
      [{ artifact_path: "a.json", artifact_sha256: DIGEST, json_pointer: { toString: () => "/x" } }, ["invalid_json_pointer"]],
      [{ artifact_path: "a.json", artifact_sha256: DIGEST, references: [] }, ["alias_rejected"]],
      [{ artifact_path: "a.json", artifact_sha256: DIGEST, evidence: [] }, ["alias_rejected"]],
      [{ artifact_path: "a.json", artifact_sha256: DIGEST, evidence_references: [] }, ["alias_rejected"]],
      [{ artifact_path: "a.json", artifact_sha256: DIGEST, package_index_sha256: "nope" }, ["invalid_sha256"]],
      [null, ["not_an_object"]],
    ];
    for (const [input, reasons] of cases) {
      assertRejected(createEvidenceRefs([input]), ...reasons);
    }
    assertRejected(createEvidenceRefs(null), "not_an_object");
    assertRejected(createEvidenceRefs({}), "not_an_object");
    const withPointer = assertAccepted(createEvidenceRefs([
      { artifact_path: "a.json", artifact_sha256: DIGEST, json_pointer: "" },
      { artifact_path: "a.json", artifact_sha256: DIGEST, json_pointer: "/x", package_index_sha256: DIGEST },
    ]));
    assert.equal(withPointer[1]?.package_index_sha256, DIGEST);
    assert.equal(withPointer[1]?.json_pointer, "/x");
  });
});

describe("primary events", () => {
  it("accepts one execution binding and sorts causation", () => {
    const created = assertAccepted(createPrimaryEvent(event({
      causation_event_ids: [CAUSE_B, CAUSE_A],
      correlation_id: "corr-1",
    })));
    assert.deepEqual(created.causation_event_ids, [CAUSE_A, CAUSE_B]);
    assert.equal(created.correlation_id, "corr-1");
    assert.equal(created.run_id, RUN_ID);
    assert.equal("transport_probe_id" in created, false);
    assert.equal("causation_event_ids" in assertAccepted(createPrimaryEvent(event())), false);
    assert.equal("correlation_id" in assertAccepted(createPrimaryEvent(event({ correlation_id: undefined }))), false);
  });

  it("accepts transport-probe and variant-validation bindings", () => {
    const probe = assertAccepted(createPrimaryEvent(event({ run_id: undefined, transport_probe_id: PROBE_ID })));
    const validation = assertAccepted(createPrimaryEvent(event({
      run_id: undefined,
      variant_validation_id: VALIDATION_ID,
    })));
    assert.equal(probe.transport_probe_id, PROBE_ID);
    assert.equal("run_id" in probe, false);
    assert.equal(validation.variant_validation_id, VALIDATION_ID);
  });

  it("carries a __proto__ correlation property as serializable data", () => {
    const injected = JSON.parse('{"__proto__":{"injected":true}}') as Record<string, unknown>;
    const created = assertAccepted(createPrimaryEvent({ ...event(), ...injected }));
    assert.equal(Object.getPrototypeOf(created), Object.prototype);
    const serialized = assertAccepted(serializeCanonicalJson(created));
    assert.ok(serialized.includes('"__proto__": {\n    "injected": true\n  }'));
  });

  it("omits empty causation and rejects non-array causation without throwing", () => {
    const omitted = assertAccepted(createPrimaryEvent(event({ causation_event_ids: [] })));
    assert.equal("causation_event_ids" in omitted, false);
    assertRejected(createPrimaryEvent(event({ causation_event_ids: "nope" })), "invalid_causation");
    assertRejected(createPrimaryEvent(event({ causation_event_ids: 1 })), "invalid_causation");
    assertRejected(createPrimaryEvent(event({ causation_event_ids: { length: 0 } })), "invalid_causation");
  });

  it("rejects invalid event envelopes with exact reasons", () => {
    const cases: Array<[unknown, string[]]> = [
      [null, ["not_an_object"]],
      [event({ run_id: undefined }), ["missing_execution_binding"]],
      [event({ transport_probe_id: PROBE_ID }), ["ambiguous_execution_binding"]],
      [event({ occurred_at: "2026-08-29T12:00:00Z" }), ["invalid_timestamp"]],
      [event({ occurred_at: "2026-02-30T12:00:00.000Z" }), ["invalid_timestamp"]],
      [event({ occurred_at: 1 }), ["invalid_timestamp"]],
      [event({ occurred_at: Object("2026-08-29T12:00:00.000Z") }), ["invalid_timestamp"]],
      [event({ event_id: "not-a-uuid" }), ["invalid_uuid"]],
      [event({ event_id: `x${EVENT_ID}` }), ["invalid_uuid"]],
      [event({ event_id: `${EVENT_ID}x` }), ["invalid_uuid"]],
      [event({ event_id: { toString: () => EVENT_ID } }), ["invalid_uuid"]],
      [event({ source_instance_id: "nope" }), ["invalid_uuid"]],
      [event({ run_id: "not-uuid" }), ["invalid_uuid"]],
      [event({ source_sequence: 0 }), ["invalid_sequence"]],
      [event({ source: "  " }), ["empty_identity"]],
      [event({ source: 1 }), ["invalid_identifier"]],
      [event({ record_type: "CallerJournal" }), ["invalid_record_type"]],
      [event({ record_type: "caller_journalX" }), ["invalid_record_type"]],
      [event({ record_type: Object("caller_journal") }), ["invalid_record_type"]],
      [event({ causation_event_ids: [CAUSE_A, CAUSE_A] }), ["invalid_causation"]],
      [event({ evidence: [] }), ["alias_rejected"]],
      [event({ references: [] }), ["alias_rejected"]],
      [event({ evidence_references: [] }), ["alias_rejected"]],
      [event({ schema_version: 2 }), ["invalid_schema_version"]],
      [event({ trial_manifest_sha256: "nope" }), ["invalid_sha256"]],
      [event({ trial_manifest_sha256: `x${DIGEST}` }), ["invalid_sha256"]],
      [event({ trial_manifest_sha256: `${DIGEST}x` }), ["invalid_sha256"]],
      [event({ trial_manifest_sha256: { toString: () => DIGEST } }), ["invalid_sha256"]],
    ];
    for (const [input, reasons] of cases) {
      assertRejected(createPrimaryEvent(input), ...reasons);
    }
  });

  it("accepts and rejects calendar bounds on occurred_at", () => {
    const accepted = [
      "2024-02-29T00:00:00.000Z",
      "2000-02-29T00:00:00.000Z",
      "0100-01-01T00:00:00.000Z",
      "2026-01-31T23:59:59.999Z",
      "2026-03-31T00:00:00.000Z",
      "2026-04-30T00:00:00.000Z",
      "2026-05-31T00:00:00.000Z",
      "2026-06-30T00:00:00.000Z",
      "2026-07-31T00:00:00.000Z",
      "2026-08-31T00:00:00.000Z",
      "2026-09-30T00:00:00.000Z",
      "2026-10-31T00:00:00.000Z",
      "2026-11-30T00:00:00.000Z",
      "2026-12-31T00:00:00.000Z",
    ];
    for (const occurred_at of accepted) {
      assertAccepted(createPrimaryEvent(event({ occurred_at })));
    }
    const rejected = [
      "2023-02-29T00:00:00.000Z",
      "1900-02-29T00:00:00.000Z",
      "0000-01-01T00:00:00.000Z",
      "0099-12-31T23:59:59.999Z",
      "x2026-08-29T12:00:00.000Z",
      "2026-08-29T12:00:00.000Zx",
      "2026-01-00T00:00:00.000Z",
      "2026-01-32T00:00:00.000Z",
      "2026-02-30T00:00:00.000Z",
      "2026-03-32T00:00:00.000Z",
      "2026-04-31T00:00:00.000Z",
      "2026-05-32T00:00:00.000Z",
      "2026-06-31T00:00:00.000Z",
      "2026-07-32T00:00:00.000Z",
      "2026-08-32T00:00:00.000Z",
      "2026-09-31T00:00:00.000Z",
      "2026-10-32T00:00:00.000Z",
      "2026-11-31T00:00:00.000Z",
      "2026-12-32T00:00:00.000Z",
      "2026-00-01T00:00:00.000Z",
      "2026-13-01T00:00:00.000Z",
      "2026-08-29T24:00:00.000Z",
      "2026-08-29T12:60:00.000Z",
      "2026-08-29T12:00:60.000Z",
    ];
    for (const occurred_at of rejected) {
      assertRejected(createPrimaryEvent(event({ occurred_at })), "invalid_timestamp");
    }
  });
});

describe("event sequences", () => {
  it("reports an empty clean sequence", () => {
    assert.deepEqual(assertAccepted(classifyEventSequence([])), emptyReport());
    assert.deepEqual(assertAccepted(classifyEventSequence([event()])), emptyReport());
    assert.deepEqual(
      assertAccepted(classifyEventSequence([
        event(),
        event({ event_id: CAUSE_A, source_sequence: 2 }),
        event({ event_id: CAUSE_B, source_sequence: 3 }),
      ])),
      emptyReport(),
    );
  });

  it("reports duplicates, conflicts, gaps, and missing causation", () => {
    assert.deepEqual(assertAccepted(classifyEventSequence([event(), event()])), {
      ...emptyReport(),
      equivalent_duplicates: 1,
    });
    assert.deepEqual(
      assertAccepted(classifyEventSequence([
        event(),
        event({ source: "other" }),
        event({ source: "third" }),
      ])),
      { ...emptyReport(), content_conflicts: [EVENT_ID] },
    );
    const gap = assertAccepted(classifyEventSequence([
      event(),
      event({ event_id: CAUSE_B, source_sequence: 3 }),
    ]));
    assert.deepEqual(gap.gaps, [`runner\n${SOURCE_INSTANCE}\n2`]);
    assert.deepEqual(
      assertAccepted(classifyEventSequence([event({ causation_event_ids: [PROBE_ID] })])),
      { ...emptyReport(), missing_causation: [PROBE_ID] },
    );
    assert.deepEqual(
      assertAccepted(classifyEventSequence([
        event({ causation_event_ids: [EVENT_ID] }),
      ])),
      emptyReport(),
    );
    const sequenceConflict = assertAccepted(classifyEventSequence([
      event(),
      event({ event_id: CAUSE_A }),
    ]));
    assert.deepEqual(sequenceConflict.sequence_conflicts, [`runner\n${SOURCE_INSTANCE}\n1`]);
    const isolatedInstances = assertAccepted(classifyEventSequence([
      event(),
      event({ event_id: CAUSE_B, source: "other", source_instance_id: PROBE_ID }),
    ]));
    assert.deepEqual(isolatedInstances, emptyReport());
    assertRejected(classifyEventSequence(null), "not_an_object");
    assertRejected(classifyEventSequence([event({ event_id: "bad" })]), "invalid_uuid");
    assertRejected(classifyEventSequence([event({ extra: 1n })]), "unserializable_value");
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
    assert.equal(
      assertAccepted(serializeCanonicalJson(proto)),
      "{\n  \"__proto__\": \"keep\",\n  \"a\": 1,\n  \"b\": 2\n}\n",
    );
    const jsonl = assertAccepted(serializeCanonicalJsonl([PAYMENT, DECISION]));
    assert.equal(jsonl.endsWith("\n"), true);
    assert.equal(jsonl.includes("\n  "), false);
  });

  it("orders integer-like keys by UTF-16 code unit rather than numeric value", () => {
    assert.equal(
      assertAccepted(serializeCanonicalJson({ "10": "a", "2": "b", "1": "c", b: 1 })),
      '{\n  "1": "c",\n  "10": "a",\n  "2": "b",\n  "b": 1\n}\n',
    );
    assert.equal(assertAccepted(structuralKey({ "10": "a", "2": "b" })), '{"10":"a","2":"b"}');
  });

  it("writes atomics and empty containers in canonical form", () => {
    assert.equal(
      assertAccepted(serializeCanonicalJson({ list: [], nested: {}, nothing: null })),
      '{\n  "list": [],\n  "nested": {},\n  "nothing": null\n}\n',
    );
    assert.equal(assertAccepted(serializeCanonicalJsonl([[], {}])), "[]\n{}\n");
    assert.equal(assertAccepted(serializeCanonicalJson(true)), "true\n");
    assert.equal(assertAccepted(serializeCanonicalJson(false)), "false\n");
    assert.equal(assertAccepted(serializeCanonicalJson(0)), "0\n");
  });

  it("serializes a value referenced more than once without reporting a cycle", () => {
    const shared = { a: 1 };
    assert.equal(
      assertAccepted(serializeCanonicalJson({ x: shared, y: shared })),
      '{\n  "x": {\n    "a": 1\n  },\n  "y": {\n    "a": 1\n  }\n}\n',
    );
    assert.equal(serializeCanonicalJson([shared, shared]).ok, true);
    const sharedList = [1];
    assert.equal(serializeCanonicalJson([sharedList, sharedList]).ok, true);
  });

  it("verifies exact bytes and lowercase SHA-256", () => {
    const serialized = assertAccepted(serializeCanonicalJson(PAYMENT));
    assert.equal(assertAccepted(verifyCanonicalBytes(PAYMENT, serialized)), serialized);
    assertRejected(verifyCanonicalBytes(PAYMENT, "{}\n"), "canonical_bytes_mismatch");
    assertRejected(verifyCanonicalBytes(1n, "{}\n"), "unserializable_value");
    const digest = sha256Hex(serialized);
    assert.equal(assertAccepted(verifyDigest(serialized, digest)), digest);
    assertRejected(verifyDigest(serialized, DIGEST), "digest_mismatch");
    assertRejected(verifyDigest(serialized, "zz"), "invalid_sha256");
    assertRejected(verifyDigest(serialized, { toString: () => digest } as unknown as string), "invalid_sha256");
  });

  it("rejects unserializable values with the unserializable reason", () => {
    const rejected = [undefined, 1n, Symbol("x"), () => 1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const value of rejected) {
      assertRejected(serializeCanonicalJson(value), "unserializable_value");
    }
    assertRejected(serializeCanonicalJsonl([1n]), "unserializable_value");
    assertRejected(serializeCanonicalJsonl([undefined]), "unserializable_value");
    assertRejected(serializeCanonicalJson({ when: new Date("2026-01-01T00:00:00.000Z") }), "unserializable_value");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assertRejected(serializeCanonicalJson(circular), "unserializable_value");
    const circularArray: unknown[] = [];
    circularArray.push(circularArray);
    assertRejected(serializeCanonicalJson(circularArray), "unserializable_value");
    assertRejected(serializeCanonicalJson([undefined]), "unserializable_value");
    assertRejected(structuralKey(1n), "unserializable_value");
    const omitted = assertAccepted(serializeCanonicalJson({ b: 1, a: undefined }));
    assert.equal(omitted, "{\n  \"b\": 1\n}\n");
    assert.equal(assertAccepted(serializeCanonicalJsonl([])), "\n");
    assert.equal(sha256Hex(new Uint8Array()).length, 64);
  });
});
