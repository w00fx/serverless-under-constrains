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

describe("deadline arbiter and AC-16", { timeout: 2000 }, () => {
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
    assert.equal(timeout.dispatched_at, "2026-09-03T12:00:03.000Z");
    assert.equal(timeout.deadline_at, "2026-09-03T12:00:06.000Z");
    assert.equal(timeout.timer_fired_at, "2026-09-03T12:00:03.010Z");
    assert.equal(timeout.abort_requested_at, "2026-09-03T12:00:03.020Z");
    assert.equal(timeout.timeout_recorded_at, "2026-09-03T12:00:03.030Z");
    const finished = result.value.events.find((event) => event.record_type === "attempt_finished");
    assert.equal(finished !== undefined, true);
    assert.equal(finished?.outcome, "TIMED_OUT");
    assert.deepEqual(finished?.causation_event_ids, [timeout.event_id]);
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

  it("re-arms an early timer so TIMED_OUT still requires a full 3s of monotonic time", async () => {
    let waits = 0;
    let reads = 0;
    const result = await invokeAttempt(
      request(),
      ports({
        transport: hangTransport(),
        timer: {
          wait: async () => {
            waits += 1;
          },
        },
        monotonic: {
          nowNs: () => {
            reads += 1;
            if (reads === 1) {
              return 0n;
            }
            return waits === 1 ? APPLICATION_DEADLINE_NS - 1n : APPLICATION_DEADLINE_NS;
          },
        },
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("re-arm");
    }
    assert.equal(waits, 2);
    assert.equal(result.value.attempt.outcome, "TIMED_OUT");
    assert.equal(
      result.value.events.some((event) => event.record_type === "caller_timeout_recorded"),
      true,
    );
  });

  it("lets transport finish after a second premature timer fire", async () => {
    let releaseTransport: ((result: TransportResult) => void) | undefined;
    let waits = 0;
    const transport: ProviderTransport = {
      invoke: () =>
        new Promise((resolve) => {
          releaseTransport = resolve;
        }),
    };
    const pending = invokeAttempt(
      request(),
      ports({
        transport,
        timer: {
          wait: async () => {
            waits += 1;
            if (waits === 2) {
              queueMicrotask(() => releaseTransport?.(accepted()));
            }
          },
        },
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
    const result = await pending;
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("second early fire");
    }
    assert.equal(waits, 2);
    assert.equal(result.value.attempt.outcome, "SUCCEEDED");
    assert.equal(
      result.value.events.some((event) => event.record_type === "caller_timeout_recorded"),
      false,
    );
  });

  it("records timeout diagnostics when dispatch wall time is not a timestamp", async () => {
    let reads = 0;
    const result = await invokeAttempt(
      request(),
      ports({
        transport: hangTransport(),
        timer: { wait: async () => undefined },
        wall: {
          now: () => {
            reads += 1;
            return reads === 3 ? "not-a-timestamp" : NOW;
          },
        },
        monotonic: {
          nowNs: (() => {
            let ticks = 0;
            return () => {
              ticks += 1;
              return ticks === 1 ? 0n : APPLICATION_DEADLINE_NS;
            };
          })(),
        },
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("invalid dispatched_at");
    }
    assert.equal(result.value.attempt.outcome, "TIMED_OUT");
    const timeout = result.value.events.find((event) => event.record_type === "caller_timeout_recorded");
    assert.equal(timeout?.dispatched_at, "not-a-timestamp");
    assert.equal(timeout?.deadline_at, "not-a-timestamp");
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

describe("arbiter and timer helpers", { timeout: 2000 }, () => {
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
    const pending = waitDuration(2_000_000_000n, live.signal);
    live.abort("stop");
    await assert.rejects(() => pending, (error: unknown) => error === "stop");
    assert.equal(deadlineTimestamp(NOW), "2026-09-03T12:00:03.000Z");
    assert.equal(deadlineTimestamp("not-a-timestamp"), "not-a-timestamp");
  });
});
