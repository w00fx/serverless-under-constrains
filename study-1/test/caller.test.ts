import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAttemptIdentities, InMemoryCallerJournal, invokeAttempt } from "../src/caller/index.ts";
import {
  PROBE,
  SOURCE,
  VALIDATION,
  accepted,
  functionFailed,
  hangTransport,
  ports,
  rejected,
  rejectTransport,
  request,
  resolveTransport,
} from "./caller-helpers.ts";

describe("caller identities", () => {
  it("mints fresh physical ids and preserves the logical refund identity", () => {
    const first = createAttemptIdentities({ refund_request_id: "  ref-poc-001  " });
    const second = createAttemptIdentities({ refund_request_id: "ref-poc-001" });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) {
      throw new Error("identities");
    }
    assert.equal(first.value.refund_request_id, "ref-poc-001");
    assert.equal(second.value.refund_request_id, "ref-poc-001");
    assert.notEqual(first.value.attempt_id, second.value.attempt_id);
    assert.notEqual(first.value.provider_request_id, second.value.provider_request_id);
  });

  it("rejects invalid logical identities and supplied physical ids", () => {
    assert.deepEqual(createAttemptIdentities("nope"), { ok: false, reasons: ["not_an_object"] });
    assert.deepEqual(createAttemptIdentities({ refund_request_id: "" }), {
      ok: false,
      reasons: ["empty_identity"],
    });
    assert.deepEqual(createAttemptIdentities({ refund_request_id: 1 }), {
      ok: false,
      reasons: ["invalid_identifier"],
    });
    assert.deepEqual(
      createAttemptIdentities({ refund_request_id: "ref-poc-001", attempt_id: "not-a-uuid" }),
      { ok: false, reasons: ["invalid_uuid"] },
    );
    assert.deepEqual(
      createAttemptIdentities({
        refund_request_id: "ref-poc-001",
        provider_request_id: "not-a-uuid",
      }),
      { ok: false, reasons: ["invalid_uuid"] },
    );
  });
});

describe("BR-3 stable logical identity", () => {
  it("keeps refund_request_id across two physical invokes", async () => {
    const journal = new InMemoryCallerJournal();
    const transport = resolveTransport(accepted());
    const first = await invokeAttempt(request(), ports({ journal, transport }));
    const second = await invokeAttempt(
      request(),
      ports({
        journal,
        transport,
        identities: {
          attempt_id: "21111111-1111-4111-8111-111111111111",
          provider_request_id: "27777777-7777-4777-8777-777777777777",
          source_instance_id: SOURCE,
        },
        event_ids: [
          "2bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          "2ccccccc-cccc-4ccc-8ccc-cccccccccccc",
          "2ddddddd-dddd-4ddd-8ddd-dddddddddddd",
        ],
      }),
    );
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) {
      throw new Error("invoke");
    }
    assert.equal(first.value.attempt.refund_request_id, "ref-poc-001");
    assert.equal(second.value.attempt.refund_request_id, "ref-poc-001");
    assert.notEqual(first.value.attempt.attempt_id, second.value.attempt.attempt_id);
    assert.notEqual(first.value.attempt.provider_request_id, second.value.attempt.provider_request_id);
    assert.equal(transport.calls, 2);
  });
});

describe("transport parsing and journal appends", () => {
  it("parses function accept, reject, fail, and transport errors without retrying", async () => {
    const accept = resolveTransport(accepted());
    const acceptedResult = await invokeAttempt(request(), ports({ transport: accept }));
    assert.equal(acceptedResult.ok, true);
    if (!acceptedResult.ok) {
      throw new Error("accepted");
    }
    assert.equal(acceptedResult.value.attempt.outcome, "SUCCEEDED");
    assert.equal(accept.calls, 1);
    const reject = resolveTransport(rejected());
    const rejectedResult = await invokeAttempt(
      request({ transport_probe_id: PROBE, run_id: undefined }),
      ports({ transport: reject }),
    );
    assert.equal(rejectedResult.ok, true);
    if (!rejectedResult.ok) {
      throw new Error("rejected");
    }
    assert.equal(rejectedResult.value.attempt.outcome, "REJECTED");
    const failed = await invokeAttempt(
      request({ variant_validation_id: VALIDATION, run_id: undefined }),
      ports({ transport: resolveTransport(functionFailed()) }),
    );
    assert.equal(failed.ok, true);
    if (!failed.ok) {
      throw new Error("failed");
    }
    assert.equal(failed.value.attempt.outcome, "FAILED");
    const transportFailed = await invokeAttempt(
      request(),
      ports({
        transport: rejectTransport(new Error("socket")),
        timer: { wait: () => new Promise(() => undefined) },
      }),
    );
    assert.equal(transportFailed.ok, true);
    if (!transportFailed.ok) {
      throw new Error("transport");
    }
    assert.equal(transportFailed.value.attempt.outcome, "FAILED");
  });

  it("retries a definitive failed append and stops a source after an ambiguous one", async () => {
    const journal = new InMemoryCallerJournal();
    journal.failNext(1);
    const retried = await invokeAttempt(request(), ports({ journal, transport: resolveTransport(accepted()) }));
    assert.equal(retried.ok, true);
    if (!retried.ok) {
      throw new Error("retry");
    }
    assert.equal(retried.value.events[0]?.source_sequence, 1);
    const ambiguous = new InMemoryCallerJournal();
    ambiguous.ambiguousNext();
    const stopped = await invokeAttempt(
      request(),
      ports({ journal: ambiguous, transport: hangTransport() }),
    );
    assert.equal(stopped.ok, true);
    if (!stopped.ok) {
      throw new Error("ambiguous");
    }
    assert.equal(stopped.value.attempt.dispatch_state, "UNKNOWN");
    assert.equal(ambiguous.isStopped(SOURCE), true);
    const again = await invokeAttempt(
      request(),
      ports({ journal: ambiguous, transport: hangTransport() }),
    );
    assert.equal(again.ok, false);
    if (again.ok) {
      throw new Error("stopped");
    }
    assert.deepEqual([...again.reasons], ["source_instance_stopped"]);
  });

  it("rejects invalid invoke input before opening an attempt", async () => {
    const journal = new InMemoryCallerJournal();
    const invalid = await invokeAttempt("nope", ports({ journal, transport: hangTransport() }));
    assert.equal(invalid.ok, false);
    assert.equal(journal.list().length, 0);
    const badSource = await invokeAttempt(
      request(),
      ports({
        journal,
        transport: hangTransport(),
        identities: { source_instance_id: "bad" },
      }),
    );
    assert.equal(badSource.ok, false);
    const badAmount = await invokeAttempt(
      request({ amount_minor: 0 }),
      ports({ journal, transport: hangTransport() }),
    );
    assert.equal(badAmount.ok, false);
  });

  it("uses default clocks when ports omit them and still lets transport win", async () => {
    const transport = resolveTransport(accepted());
    const result = await invokeAttempt(request(), {
      journal: new InMemoryCallerJournal(),
      transport,
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("defaults");
    }
    assert.equal(result.value.attempt.outcome, "SUCCEEDED");
  });
});
