import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyDispatch,
  createRetryEnvelope,
  projectAttempts,
  projectKnowledge,
  projectProcessing,
} from "../src/caller/index.ts";
import { createPrimaryEvent } from "../src/protocol-records/index.ts";
import {
  ATTEMPT,
  DIGEST,
  EVENT_A,
  EVENT_B,
  EVENT_C,
  EVENT_D,
  NOW,
  REQUEST,
  RUN,
  SOURCE,
  attempt,
} from "./caller-helpers.ts";

describe("BR-4 knowledge and retry-layer processing", { timeout: 2000 }, () => {
  it("applies the absorbing UNKNOWN transitions", () => {
    assert.equal(projectKnowledge([]), "NOT_ATTEMPTED");
    assert.equal(projectKnowledge([attempt("FAILED", "NOT_DISPATCHED")]), "NOT_ATTEMPTED");
    assert.equal(projectKnowledge([attempt("FAILED", "DISPATCHED")]), "UNKNOWN");
    assert.equal(projectKnowledge([attempt("FAILED", "UNKNOWN")]), "UNKNOWN");
    assert.equal(projectKnowledge([attempt("TIMED_OUT", "DISPATCHED")]), "UNKNOWN");
    assert.equal(projectKnowledge([attempt("REJECTED", "DISPATCHED")]), "NO_EFFECT_CONFIRMED");
    assert.equal(projectKnowledge([attempt("SUCCEEDED", "DISPATCHED")]), "ONE_EFFECT_CONFIRMED");
    assert.equal(
      projectKnowledge([attempt("SUCCEEDED", "DISPATCHED"), attempt("SUCCEEDED", "DISPATCHED", "2")]),
      "MULTIPLE_EFFECTS_CONFIRMED",
    );
    assert.equal(
      projectKnowledge([
        attempt("TIMED_OUT", "DISPATCHED"),
        attempt("REJECTED", "DISPATCHED", "2"),
        attempt("FAILED", "DISPATCHED", "3"),
      ]),
      "UNKNOWN",
    );
    assert.equal(
      projectKnowledge([attempt("REJECTED", "DISPATCHED"), attempt("SUCCEEDED", "DISPATCHED", "2")]),
      "ONE_EFFECT_CONFIRMED",
    );
    assert.equal(
      projectKnowledge([
        attempt("SUCCEEDED", "DISPATCHED"),
        attempt("FAILED", "NOT_DISPATCHED", "2"),
      ]),
      "ONE_EFFECT_CONFIRMED",
    );
  });

  it("does not exhaust retries while an upstream layer remains", () => {
    const timedOut = [attempt("TIMED_OUT", "DISPATCHED")];
    const running = projectProcessing(timedOut, { inner_remaining: 0, upstream_remaining: 1 });
    assert.equal(running.ok, true);
    if (!running.ok) {
      throw new Error("running");
    }
    assert.equal(running.value.processing_state, "RUNNING");
    assert.equal(running.value.processing_terminal_reason, undefined);
    const exhausted = projectProcessing(timedOut, { inner_remaining: 0, upstream_remaining: 0 });
    assert.equal(exhausted.ok, true);
    if (!exhausted.ok) {
      throw new Error("exhausted");
    }
    assert.equal(exhausted.value.processing_state, "FINISHED");
    assert.equal(exhausted.value.processing_terminal_reason, "RETRIES_EXHAUSTED");
    const rejected = projectProcessing([attempt("REJECTED", "DISPATCHED")], {
      inner_remaining: 0,
      upstream_remaining: 0,
    });
    assert.equal(rejected.ok, true);
    if (!rejected.ok) {
      throw new Error("rejected");
    }
    assert.equal(rejected.value.processing_state, "FINISHED");
    assert.equal(rejected.value.processing_terminal_reason, "PROVIDER_REJECTED");
    const empty = projectProcessing([], { inner_remaining: 1, upstream_remaining: 0 });
    assert.equal(empty.ok, true);
    if (!empty.ok) {
      throw new Error("empty");
    }
    assert.equal(empty.value.processing_state, "NOT_STARTED");
    assert.deepEqual(createRetryEnvelope({ inner_remaining: -1, upstream_remaining: 0 }), {
      ok: false,
      reasons: ["invalid_retry_envelope"],
    });
    assert.deepEqual(createRetryEnvelope("nope"), { ok: false, reasons: ["not_an_object"] });
    assert.equal(projectProcessing(timedOut, { inner_remaining: 0.5, upstream_remaining: 0 }).ok, false);
  });
});

describe("projections from journals", { timeout: 2000 }, () => {
  it("projects attempts from caller events and ignores records without identities", () => {
    const timeout = createPrimaryEvent({
      schema_version: 1,
      record_type: "caller_timeout_recorded",
      event_id: EVENT_B,
      occurred_at: NOW,
      source: "caller",
      source_instance_id: SOURCE,
      source_sequence: 2,
      trial_manifest_sha256: DIGEST,
      run_id: RUN,
      attempt_id: ATTEMPT,
      provider_request_id: REQUEST,
      refund_request_id: "ref-poc-001",
    });
    const opened = createPrimaryEvent({
      schema_version: 1,
      record_type: "attempt_opened",
      event_id: EVENT_A,
      occurred_at: NOW,
      source: "caller",
      source_instance_id: SOURCE,
      source_sequence: 1,
      trial_manifest_sha256: DIGEST,
      run_id: RUN,
      attempt_id: ATTEMPT,
      provider_request_id: REQUEST,
      refund_request_id: "ref-poc-001",
    });
    assert.equal(opened.ok && timeout.ok, true);
    if (!opened.ok || !timeout.ok) {
      throw new Error("events");
    }
    const projected = projectAttempts([opened.value, timeout.value]);
    assert.equal(projected.length, 1);
    assert.equal(projected[0]?.outcome, "TIMED_OUT");
    assert.equal(projected[0]?.dispatch_state, "DISPATCHED");
    const finished = createPrimaryEvent({
      schema_version: 1,
      record_type: "attempt_finished",
      event_id: EVENT_C,
      occurred_at: NOW,
      source: "caller",
      source_instance_id: SOURCE,
      source_sequence: 3,
      trial_manifest_sha256: DIGEST,
      run_id: RUN,
      attempt_id: ATTEMPT,
      outcome: "SUCCEEDED",
    });
    assert.equal(finished.ok, true);
    if (!finished.ok) {
      throw new Error("finished");
    }
    assert.equal(classifyDispatch([finished.value], ATTEMPT), "DISPATCHED");
    const bare = createPrimaryEvent({
      schema_version: 1,
      record_type: "attempt_opened",
      event_id: EVENT_D,
      occurred_at: NOW,
      source: "caller",
      source_instance_id: SOURCE,
      source_sequence: 4,
      trial_manifest_sha256: DIGEST,
      run_id: RUN,
      attempt_id: "31111111-1111-4111-8111-111111111111",
    });
    assert.equal(bare.ok, true);
    if (!bare.ok) {
      throw new Error("bare");
    }
    assert.equal(projectAttempts([bare.value]).length, 0);
  });
});
