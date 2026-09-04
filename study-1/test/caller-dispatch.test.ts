import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyDispatch,
  InMemoryCallerJournal,
  invokeAttempt,
  projectKnowledge,
} from "../src/caller/index.ts";
import {
  ATTEMPT,
  EVENT_A,
  EVENT_B,
  EVENT_C,
  EVENT_D,
  REQUEST,
  SOURCE,
  accepted,
  functionFailed,
  hangTransport,
  ports,
  request,
  resolveTransport,
} from "./caller-helpers.ts";

describe("AC-15 dispatch classification", () => {
  it("records NOT_DISPATCHED only after a conditional pre-dispatch proof", async () => {
    const journal = new InMemoryCallerJournal();
    const transport = resolveTransport(accepted());
    const result = await invokeAttempt(
      request(),
      ports({ journal, transport, pre_dispatch_failure: ["local_prepare_failed"] }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("invoke");
    }
    assert.equal(result.value.attempt.dispatch_state, "NOT_DISPATCHED");
    assert.equal(result.value.attempt.outcome, "FAILED");
    assert.equal(projectKnowledge([result.value.attempt]), "NOT_ATTEMPTED");
    assert.equal(transport.calls, 0);
    assert.equal(
      result.value.events.some((event) => event.record_type === "pre_dispatch_failed"),
      true,
    );
    assert.equal(classifyDispatch([], ATTEMPT), "UNKNOWN");
    assert.equal(classifyDispatch(journal.list(), ATTEMPT), "NOT_DISPATCHED");
  });

  it("does not treat missing provider or ledger evidence as NOT_DISPATCHED", async () => {
    const journal = new InMemoryCallerJournal();
    journal.failNext(2);
    const result = await invokeAttempt(request(), ports({ journal, transport: hangTransport() }));
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("invoke");
    }
    assert.equal(result.value.attempt.dispatch_state, "UNKNOWN");
    assert.equal(result.value.events.length, 0);
    assert.equal(classifyDispatch([], ATTEMPT), "UNKNOWN");
  });

  it("keeps DISPATCHED when the dispatch boundary was already crossed", async () => {
    const journal = new InMemoryCallerJournal();
    const opened = await invokeAttempt(
      request(),
      ports({
        journal,
        transport: resolveTransport(functionFailed()),
        event_ids: [EVENT_A, EVENT_B, EVENT_C],
      }),
    );
    assert.equal(opened.ok, true);
    const crossed = await invokeAttempt(
      request(),
      ports({
        journal,
        transport: hangTransport(),
        identities: {
          attempt_id: ATTEMPT,
          provider_request_id: REQUEST,
          source_instance_id: SOURCE,
        },
        event_ids: [EVENT_D],
        pre_dispatch_failure: ["too_late"],
      }),
    );
    assert.equal(crossed.ok, true);
    if (!crossed.ok) {
      throw new Error("crossed");
    }
    assert.equal(classifyDispatch(journal.list(), ATTEMPT), "DISPATCHED");
    assert.notEqual(crossed.value.attempt.dispatch_state, "NOT_DISPATCHED");
  });

  it("classifies a failed pre-dispatch proof as UNKNOWN", async () => {
    const failedProof = new InMemoryCallerJournal();
    failedProof.skipNext(1);
    failedProof.failNext(2);
    const uncertain = await invokeAttempt(
      request(),
      ports({
        journal: failedProof,
        transport: hangTransport(),
        pre_dispatch_failure: ["local_prepare_failed"],
      }),
    );
    assert.equal(uncertain.ok, true);
    if (!uncertain.ok) {
      throw new Error("uncertain");
    }
    assert.equal(uncertain.value.attempt.dispatch_state, "UNKNOWN");
    assert.equal(
      uncertain.value.events.some((event) => event.record_type === "pre_dispatch_failed"),
      false,
    );
  });

  it("classifies an ambiguous pre-dispatch proof as UNKNOWN", async () => {
    const ambiguousProof = new InMemoryCallerJournal();
    ambiguousProof.skipNext(1);
    ambiguousProof.ambiguousNext();
    const ambiguous = await invokeAttempt(
      request(),
      ports({
        journal: ambiguousProof,
        transport: hangTransport(),
        pre_dispatch_failure: ["local_prepare_failed"],
      }),
    );
    assert.equal(ambiguous.ok, true);
    if (!ambiguous.ok) {
      throw new Error("ambiguous proof");
    }
    assert.equal(ambiguous.value.attempt.dispatch_state, "UNKNOWN");
  });

  it("retries one failed pre-dispatch proof and then records NOT_DISPATCHED", async () => {
    const recovered = new InMemoryCallerJournal();
    recovered.skipNext(1);
    recovered.failNext(1);
    const proved = await invokeAttempt(
      request(),
      ports({
        journal: recovered,
        transport: hangTransport(),
        pre_dispatch_failure: ["local_prepare_failed"],
      }),
    );
    assert.equal(proved.ok, true);
    if (!proved.ok) {
      throw new Error("recovered");
    }
    assert.equal(proved.value.attempt.dispatch_state, "NOT_DISPATCHED");
  });

  it("does not treat a missing dispatch_started write as NOT_DISPATCHED", async () => {
    const dispatchUnknown = new InMemoryCallerJournal();
    dispatchUnknown.skipNext(1);
    dispatchUnknown.failNext(2);
    const missingDispatch = await invokeAttempt(
      request(),
      ports({ journal: dispatchUnknown, transport: hangTransport() }),
    );
    assert.equal(missingDispatch.ok, true);
    if (!missingDispatch.ok) {
      throw new Error("missing dispatch");
    }
    assert.equal(missingDispatch.value.attempt.dispatch_state, "UNKNOWN");
  });

  it("does not treat an unwritable opening timestamp as NOT_DISPATCHED", async () => {
    const badClock = await invokeAttempt(
      request(),
      ports({
        journal: new InMemoryCallerJournal(),
        transport: hangTransport(),
        wall: { now: () => "not-a-timestamp" },
      }),
    );
    assert.equal(badClock.ok, true);
    if (!badClock.ok) {
      throw new Error("bad clock");
    }
    assert.equal(badClock.value.attempt.dispatch_state, "UNKNOWN");
    assert.equal(badClock.value.events.length, 0);
  });
});
