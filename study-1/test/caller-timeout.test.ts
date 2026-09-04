import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APPLICATION_DEADLINE_NS,
  createArbiter,
  deadlineTimestamp,
  durationToMs,
  InMemoryCallerJournal,
  invokeAttempt,
  projectKnowledge,
  projectProcessing,
  waitDuration,
} from "../src/caller/index.ts";
import type { ProviderTransport, TransportResult } from "../src/caller/index.ts";
import {
  EVENT_A,
  EVENT_B,
  EVENT_C,
  NOW,
  accepted,
  attempt,
  clocks,
  hangTransport,
  ports,
  rejectTransport,
  request,
  resolveTransport,
} from "./caller-helpers.ts";

describe("deadline arbiter and AC-16", () => {
  it("records TIMED_OUT only after 3s, abort, and a durable timeout event", async () => {
    const clock = clocks(APPLICATION_DEADLINE_NS, [
      NOW,
      NOW,
      "2026-09-03T12:00:03.000Z",
      "2026-09-03T12:00:03.010Z",
      "2026-09-03T12:00:03.020Z",
      "2026-09-03T12:00:03.030Z",
    ]);
    const journal = new InMemoryCallerJournal();
    const result = await invokeAttempt(
      request(),
      ports({
        journal,
        transport: hangTransport(),
        timer: { wait: async () => undefined },
        wall: clock.wall,
        monotonic: clock.monotonic,
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("timeout");
    }
    assert.equal(result.value.attempt.outcome, "TIMED_OUT");
    assert.equal(result.value.attempt.dispatch_state, "DISPATCHED");
    const timeout = result.value.events.find((event) => event.record_type === "caller_timeout_recorded");
    assert.equal(timeout !== undefined, true);
    if (timeout === undefined) {
      throw new Error("timeout event");
    }
    assert.equal(timeout.elapsed_monotonic_ns, "3000000000");
    assert.equal(timeout.monotonic_origin_event_id, EVENT_B);
    assert.deepEqual(timeout.causation_event_ids, [EVENT_B]);
    assert.equal(typeof timeout.dispatched_at, "string");
    assert.equal(timeout.deadline_at, deadlineTimestamp(String(timeout.dispatched_at)));
    assert.equal(projectKnowledge([result.value.attempt]), "UNKNOWN");
  });

  it("does not treat a premature timer or abort error as TIMED_OUT", async () => {
    const early = await invokeAttempt(
      request(),
      ports({
        transport: resolveTransport(accepted()),
        timer: { wait: async () => undefined },
        monotonic: {
          nowNs: (() => {
            let reads = 0;
            return () => {
              reads += 1;
              return reads === 1 ? 0n : APPLICATION_DEADLINE_NS - 1n;
            };
          })(),
        },
      }),
    );
    assert.equal(early.ok, true);
    if (!early.ok) {
      throw new Error("early");
    }
    assert.equal(early.value.attempt.outcome, "SUCCEEDED");
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    const aborted = await invokeAttempt(
      request(),
      ports({
        transport: rejectTransport(abortError),
        timer: { wait: () => new Promise(() => undefined) },
        event_ids: [EVENT_A, EVENT_B, EVENT_C],
      }),
    );
    assert.equal(aborted.ok, true);
    if (!aborted.ok) {
      throw new Error("aborted");
    }
    assert.equal(aborted.value.attempt.outcome, "FAILED");
    assert.equal(aborted.value.attempt.dispatch_state, "DISPATCHED");
    assert.equal(
      aborted.value.events.some((event) => event.record_type === "caller_timeout_recorded"),
      false,
    );
  });

  it("lets only one winner settle when timer and transport race", async () => {
    const journal = new InMemoryCallerJournal();
    let releaseTransport: ((result: TransportResult) => void) | undefined;
    const transport: ProviderTransport = {
      invoke: () =>
        new Promise((resolve) => {
          releaseTransport = resolve;
        }),
    };
    const pending = invokeAttempt(
      request(),
      ports({
        journal,
        transport,
        timer: { wait: async () => undefined },
        monotonic: {
          nowNs: (() => {
            let reads = 0;
            return () => {
              reads += 1;
              return reads === 1 ? 0n : APPLICATION_DEADLINE_NS;
            };
          })(),
        },
      }),
    );
    await Promise.resolve();
    releaseTransport?.(accepted());
    const result = await pending;
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("race");
    }
    const outcomes = result.value.events
      .filter((event) => event.record_type === "attempt_finished")
      .map((event) => event.outcome);
    assert.equal(outcomes.length <= 1, true);
    assert.equal(
      result.value.attempt.outcome === "TIMED_OUT" || result.value.attempt.outcome === "SUCCEEDED",
      true,
    );
    if (result.value.attempt.outcome === "TIMED_OUT") {
      assert.equal(
        result.value.events.some((event) => event.record_type === "attempt_finished" && event.outcome === "SUCCEEDED"),
        false,
      );
    }
  });

  it("keeps aggregate UNKNOWN after a later success finishes processing", async () => {
    const timedOut = attempt("TIMED_OUT", "DISPATCHED");
    const succeeded = attempt("SUCCEEDED", "DISPATCHED", "21111111-1111-4111-8111-111111111111");
    assert.equal(projectKnowledge([timedOut, succeeded]), "UNKNOWN");
    const processing = projectProcessing([timedOut, succeeded], {
      inner_remaining: 0,
      upstream_remaining: 0,
    });
    assert.equal(processing.ok, true);
    if (!processing.ok) {
      throw new Error("processing");
    }
    assert.equal(processing.value.processing_state, "FINISHED");
    assert.equal(processing.value.processing_terminal_reason, "SUCCEEDED");
  });
});

describe("arbiter and timer helpers", () => {
  it("covers arbiter, timer, and duration helpers", async () => {
    const arbiter = createArbiter();
    const first = arbiter.settle({
      winner: "timer",
      elapsed_ns: APPLICATION_DEADLINE_NS,
      fired_at: NOW,
    });
    const second = arbiter.settle({
      winner: "transport",
      result: accepted(),
      elapsed_ns: 1n,
    });
    assert.equal(first?.winner, "timer");
    assert.equal(second, undefined);
    assert.equal(durationToMs(APPLICATION_DEADLINE_NS), 3000);
    assert.equal(durationToMs(0n), 0);
    assert.equal(durationToMs(BigInt(Number.MAX_SAFE_INTEGER) * 1_000_000n + 1n), Number.MAX_SAFE_INTEGER);
    await waitDuration(0n, new AbortController().signal);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(() => waitDuration(1n, aborted.signal));
    const live = new AbortController();
    const pending = waitDuration(60_000_000_000n, live.signal);
    live.abort();
    await assert.rejects(() => pending);
    assert.equal(deadlineTimestamp(NOW), "2026-09-03T12:00:03.000Z");
  });
});
