import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APPLICATION_DEADLINE_NS,
  attemptFromEvents,
  classifyDispatch,
  deadlineTimestamp,
  InMemoryCallerJournal,
  invokeAttempt,
  nextKnowledge,
  projectAttempts,
  projectKnowledge,
  waitDuration,
} from "../src/caller/index.ts";
import type { ProviderTransport, TransportResult } from "../src/caller/index.ts";
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
  accepted,
  attempt,
  hangTransport,
  ports,
  request,
  resolveTransport,
  ScriptedCallerJournal,
} from "./caller-helpers.ts";

const SOURCE_B = "abbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SUITE = { timeout: 2000 };

function openedEvent(overrides: Record<string, unknown> = {}) {
  return createPrimaryEvent({
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
    ...overrides,
  });
}

describe("caller mutation: journal and identities", SUITE, () => {
  it("retries one failed open append and then commits the same event", async () => {
    const journal = new ScriptedCallerJournal(["failed", "committed", "committed", "committed"]);
    const result = await invokeAttempt(request(), ports({ journal, transport: resolveTransport(accepted()) }));
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("retry open");
    }
    assert.equal(result.value.events[0]?.event_id, EVENT_A);
    assert.equal(result.value.attempt.outcome, "SUCCEEDED");
  });

  it("does not retry an ambiguous append even when a later append would commit", async () => {
    const journal = new ScriptedCallerJournal(["ambiguous", "committed"]);
    const result = await invokeAttempt(request(), ports({ journal, transport: hangTransport() }));
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("ambiguous");
    }
    assert.equal(result.value.events.length, 0);
    assert.equal(journal.list().length, 0);
  });

  it("does not retry an ambiguous pre-dispatch proof when a later write would commit", async () => {
    const journal = new ScriptedCallerJournal(["committed", "ambiguous", "committed"]);
    const result = await invokeAttempt(
      request(),
      ports({ journal, transport: hangTransport(), pre_dispatch_failure: ["local_prepare_failed"] }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("ambiguous pre-dispatch");
    }
    assert.equal(
      result.value.events.some((event) => event.record_type === "pre_dispatch_failed"),
      false,
    );
    assert.equal(result.value.attempt.dispatch_state, "UNKNOWN");
  });

  it("returns the committed pre-dispatch event after one failed conditional append", async () => {
    const journal = new ScriptedCallerJournal(["committed", "failed", "committed", "committed"]);
    const result = await invokeAttempt(
      request(),
      ports({ journal, transport: hangTransport(), pre_dispatch_failure: ["local_prepare_failed"] }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("retry pre-dispatch");
    }
    assert.equal(result.value.attempt.dispatch_state, "NOT_DISPATCHED");
    assert.equal(
      result.value.events.some((event) => event.record_type === "attempt_finished"),
      true,
    );
    const finished = result.value.events.find((event) => event.record_type === "attempt_finished");
    assert.equal(finished?.outcome, "FAILED");
    const failed = result.value.events.find((event) => event.record_type === "pre_dispatch_failed");
    assert.deepEqual(failed?.causation_event_ids, [EVENT_A]);
    assert.deepEqual(failed?.reasons, ["local_prepare_failed"]);
    assert.deepEqual(finished?.causation_event_ids, [failed?.event_id]);
  });

  it("does not re-append a pre-dispatch proof that already committed", async () => {
    const journal = new ScriptedCallerJournal(["committed", "committed", "failed"]);
    const result = await invokeAttempt(
      request(),
      ports({ journal, transport: hangTransport(), pre_dispatch_failure: ["local_prepare_failed"] }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("already committed");
    }
    assert.equal(
      result.value.events.filter((event) => event.record_type === "pre_dispatch_failed").length,
      1,
    );
    assert.equal(
      result.value.events.some((event) => event.record_type === "attempt_finished"),
      true,
    );
  });

  it("reports not_an_object when invoke input is not a record", async () => {
    const result = await invokeAttempt("nope", ports({ transport: hangTransport() }));
    assert.deepEqual(result, { ok: false, reasons: ["not_an_object"] });
  });

  it("returns failed from failNext and predicate rejection", () => {
    const journal = new InMemoryCallerJournal();
    const built = openedEvent();
    assert.equal(built.ok, true);
    if (!built.ok) {
      throw new Error("opened");
    }
    journal.failNext();
    assert.equal(journal.append(built.value), "failed");
    assert.equal(journal.appendConditional(built.value, () => false), "failed");
  });

  it("clears the ambiguous flag so a later source can still commit", () => {
    const first = openedEvent();
    const second = openedEvent({
      event_id: EVENT_B,
      source_instance_id: SOURCE_B,
      attempt_id: "21111111-1111-4111-8111-111111111111",
      provider_request_id: "27777777-7777-4777-8777-777777777777",
    });
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) {
      throw new Error("events");
    }
    const journal = new InMemoryCallerJournal();
    journal.ambiguousNext();
    assert.equal(journal.append(first.value), "ambiguous");
    assert.equal(journal.append(second.value), "committed");
    assert.equal(journal.list().length, 1);
  });

  it("orders same-source events by sequence, not by insertion", () => {
    const later = openedEvent({ event_id: EVENT_B, source_sequence: 2 });
    const earlier = openedEvent({ event_id: EVENT_C, source_sequence: 1 });
    assert.equal(later.ok && earlier.ok, true);
    if (!later.ok || !earlier.ok) {
      throw new Error("events");
    }
    const journal = new InMemoryCallerJournal();
    assert.equal(journal.append(later.value), "committed");
    assert.equal(journal.append(earlier.value), "committed");
    assert.deepEqual(
      journal.list().map((event) => event.source_sequence),
      [1, 2],
    );
  });

  it("does not append a late pre-dispatch proof after dispatch already landed", async () => {
    const journal = new InMemoryCallerJournal();
    const opened = await invokeAttempt(
      request(),
      ports({
        journal,
        transport: resolveTransport({
          layer: "function",
          outcome: "failed",
          reasons: ["transact_failed"],
        }),
        event_ids: [EVENT_A, EVENT_B, EVENT_C],
      }),
    );
    assert.equal(opened.ok, true);
    const crossed = await invokeAttempt(
      request(),
      ports({
        journal,
        transport: hangTransport(),
        event_ids: [EVENT_D],
        pre_dispatch_failure: ["too_late"],
      }),
    );
    assert.equal(crossed.ok, true);
    if (!crossed.ok) {
      throw new Error("crossed");
    }
    assert.equal(
      crossed.value.events.some((event) => event.record_type === "pre_dispatch_failed"),
      false,
    );
    assert.equal(classifyDispatch(journal.list(), ATTEMPT), "DISPATCHED");
  });
});

describe("caller mutation: snapshot, transport, and deadline", SUITE, () => {
  it("scopes snapshot events to the current attempt", async () => {
    const journal = new InMemoryCallerJournal();
    const first = await invokeAttempt(request(), ports({ journal, transport: resolveTransport(accepted()) }));
    const second = await invokeAttempt(
      request(),
      ports({
        journal,
        transport: resolveTransport(accepted()),
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
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) {
      throw new Error("invoke");
    }
    assert.equal(
      second.value.events.every((event) => event.attempt_id === second.value.attempt.attempt_id),
      true,
    );
    assert.equal(
      second.value.events.some((event) => event.attempt_id === first.value.attempt.attempt_id),
      false,
    );
  });

  it("does not treat a non-function layer as accepted even when outcome says accepted", async () => {
    const result = await invokeAttempt(
      request(),
      ports({
        transport: {
          invoke: async () =>
            ({
              layer: "transport",
              kind: "error",
              reasons: ["x"],
              outcome: "accepted",
            }) as TransportResult,
        },
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("layer");
    }
    assert.equal(result.value.attempt.outcome, "FAILED");
    const finished = result.value.events.find((event) => event.record_type === "attempt_finished");
    assert.equal(finished?.outcome, "FAILED");
  });

  it("records FAILED on the finished event for a thrown transport error", async () => {
    let reads = 0;
    const result = await invokeAttempt(
      request(),
      ports({
        transport: {
          invoke: async () => {
            throw new Error("socket");
          },
        },
        timer: { wait: () => new Promise(() => undefined) },
        monotonic: {
          nowNs: () => {
            reads += 1;
            return reads === 1 ? 7n : 10n;
          },
        },
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("thrown");
    }
    const finished = result.value.events.find((event) => event.record_type === "attempt_finished");
    assert.equal(finished?.outcome, "FAILED");
    assert.deepEqual(finished?.reasons, ["transport_error"]);
    assert.equal(finished?.layer, "transport");
    assert.equal(finished?.kind, "error");
    assert.equal(finished?.elapsed_monotonic_ns, "3");
    assert.deepEqual(finished?.causation_event_ids, [EVENT_B]);
  });

  it("records elapsed monotonic time from a non-zero origin when transport wins", async () => {
    let reads = 0;
    const result = await invokeAttempt(
      request(),
      ports({
        transport: resolveTransport(accepted()),
        timer: { wait: () => new Promise(() => undefined) },
        monotonic: {
          nowNs: () => {
            reads += 1;
            return reads === 1 ? 7n : 10n;
          },
        },
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("elapsed");
    }
    const finished = result.value.events.find((event) => event.record_type === "attempt_finished");
    assert.equal(finished?.elapsed_monotonic_ns, "3");
    assert.equal(finished?.layer, "function");
    const dispatched = result.value.events.find((event) => event.record_type === "dispatch_started");
    assert.deepEqual(dispatched?.causation_event_ids, [EVENT_A]);
  });

  it("uses default monotonic time so an early fire re-arms with a bigint remainder", async () => {
    const durations: bigint[] = [];
    let waits = 0;
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
        transport,
        timer: {
          wait: async (durationNs) => {
            durations.push(durationNs);
            waits += 1;
            if (waits === 2) {
              queueMicrotask(() => releaseTransport?.(accepted()));
            }
          },
        },
        monotonic: undefined,
      }),
    );
    const result = await pending;
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("default monotonic");
    }
    assert.equal(waits, 2);
    assert.equal(typeof durations[1], "bigint");
    assert.equal((durations[1] ?? 0n) > 0n, true);
    assert.equal(result.value.attempt.outcome, "SUCCEEDED");
  });

  it("re-arms with the remaining deadline from a non-zero monotonic origin", async () => {
    const originNs = 5_000_000_000n;
    const durations: bigint[] = [];
    let waits = 0;
    let reads = 0;
    const result = await invokeAttempt(
      request(),
      ports({
        transport: hangTransport(),
        timer: {
          wait: async (durationNs) => {
            durations.push(durationNs);
            waits += 1;
          },
        },
        monotonic: {
          nowNs: () => {
            reads += 1;
            if (reads === 1) {
              return originNs;
            }
            return waits === 1 ? originNs + APPLICATION_DEADLINE_NS - 1n : originNs + APPLICATION_DEADLINE_NS;
          },
        },
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("re-arm remainder");
    }
    assert.equal(waits, 2);
    assert.equal(durations[1], 1n);
    assert.equal(result.value.attempt.outcome, "TIMED_OUT");
  });

  it("does not re-arm a timer that fires after transport already won", async () => {
    let waits = 0;
    let releaseTimer: (() => void) | undefined;
    const pending = invokeAttempt(
      request(),
      ports({
        transport: resolveTransport(accepted()),
        timer: {
          wait: () => {
            waits += 1;
            return new Promise<void>((resolve) => {
              releaseTimer = resolve;
            });
          },
        },
      }),
    );
    const result = await pending;
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("post-win fire");
    }
    assert.equal(result.value.attempt.outcome, "SUCCEEDED");
    releaseTimer?.();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(waits, 1);
  });

  it("aborts transport only when the timer wins, and aborts the timer only when transport wins", async () => {
    let transportAborted = false;
    const timedOut = await invokeAttempt(
      request(),
      ports({
        transport: {
          invoke: (_call, signal) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                transportAborted = true;
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              });
            }),
        },
        timer: { wait: async () => undefined },
        monotonic: {
          nowNs: (() => {
            let reads = 0;
            return () => {
              reads += 1;
              return reads === 1 ? 1n : 1n + APPLICATION_DEADLINE_NS;
            };
          })(),
        },
      }),
    );
    assert.equal(timedOut.ok, true);
    if (!timedOut.ok) {
      throw new Error("timer win");
    }
    assert.equal(timedOut.value.attempt.outcome, "TIMED_OUT");
    assert.equal(transportAborted, true);
    let seen: AbortSignal | undefined;
    const succeeded = await invokeAttempt(
      request(),
      ports({
        transport: {
          invoke: async (_call, signal) => {
            seen = signal;
            return accepted();
          },
        },
        timer: { wait: () => new Promise(() => undefined) },
      }),
    );
    assert.equal(succeeded.ok, true);
    if (!succeeded.ok) {
      throw new Error("transport win");
    }
    assert.equal(succeeded.value.attempt.outcome, "SUCCEEDED");
    assert.equal(seen?.aborted, false);
  });
});

describe("caller mutation: knowledge projections", SUITE, () => {
  it("treats a lone REJECTED finished event as dispatched", () => {
    const rejected = createPrimaryEvent({
      schema_version: 1,
      record_type: "attempt_finished",
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
      outcome: "REJECTED",
    });
    assert.equal(rejected.ok, true);
    if (!rejected.ok) {
      throw new Error("rejected");
    }
    assert.equal(classifyDispatch([rejected.value], ATTEMPT), "DISPATCHED");
  });

  it("reads TIMED_OUT from a lone finished event and ignores an invalid finished outcome", () => {
    const timedOut = createPrimaryEvent({
      schema_version: 1,
      record_type: "attempt_finished",
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
      outcome: "TIMED_OUT",
    });
    const invalid = createPrimaryEvent({
      schema_version: 1,
      record_type: "attempt_finished",
      event_id: EVENT_B,
      occurred_at: NOW,
      source: "caller",
      source_instance_id: SOURCE,
      source_sequence: 2,
      trial_manifest_sha256: DIGEST,
      run_id: RUN,
      attempt_id: "21111111-1111-4111-8111-111111111111",
      provider_request_id: REQUEST,
      refund_request_id: "ref-poc-001",
      outcome: "WEIRD",
    });
    assert.equal(timedOut.ok && invalid.ok, true);
    if (!timedOut.ok || !invalid.ok) {
      throw new Error("finished");
    }
    const fromFinished = attemptFromEvents([timedOut.value], ATTEMPT);
    assert.equal(fromFinished?.outcome, "TIMED_OUT");
    assert.equal(fromFinished?.dispatch_state, "DISPATCHED");
    const fromInvalid = attemptFromEvents([invalid.value], "21111111-1111-4111-8111-111111111111");
    assert.equal(fromInvalid?.outcome, "FAILED");
  });

  it("keeps identities from attempt_opened when a later event drops them", () => {
    const opened = openedEvent();
    const later = createPrimaryEvent({
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
      refund_request_id: "ref-poc-001",
    });
    assert.equal(opened.ok && later.ok, true);
    if (!opened.ok || !later.ok) {
      throw new Error("events");
    }
    const projected = projectAttempts([later.value, opened.value]);
    assert.equal(projected.length, 1);
    assert.equal(projected[0]?.provider_request_id, REQUEST);
    assert.equal(projected[0]?.outcome, "TIMED_OUT");
  });

  it("projects an attempt whose id matches a poisoned seen-list seed", () => {
    const opened = openedEvent();
    assert.equal(opened.ok, true);
    if (!opened.ok) {
      throw new Error("opened");
    }
    const poisoned = { ...opened.value, event_id: EVENT_B, attempt_id: "Stryker was here", source_sequence: 2 };
    const projected = projectAttempts([opened.value, poisoned]);
    assert.equal(projected.length, 2);
    assert.equal(projected.some((record) => record.attempt_id === "Stryker was here"), true);
  });

  it("drops an attempt whose refund_request_id is not a string", () => {
    const opened = openedEvent();
    assert.equal(opened.ok, true);
    if (!opened.ok) {
      throw new Error("opened");
    }
    assert.deepEqual(projectAttempts([{ ...opened.value, refund_request_id: 1 }]), []);
  });

  it("ignores journal rows whose attempt_id is not a string", () => {
    const opened = openedEvent();
    assert.equal(opened.ok, true);
    if (!opened.ok) {
      throw new Error("opened");
    }
    const numericId = { ...opened.value, attempt_id: 42 };
    assert.deepEqual(projectAttempts([numericId]), []);
  });

  it("stays on MULTIPLE_EFFECTS_CONFIRMED after a later success", () => {
    assert.equal(
      nextKnowledge("MULTIPLE_EFFECTS_CONFIRMED", attempt("SUCCEEDED", "DISPATCHED")),
      "MULTIPLE_EFFECTS_CONFIRMED",
    );
    assert.equal(projectKnowledge([attempt("TIMED_OUT", "NOT_DISPATCHED")]), "UNKNOWN");
  });

  it("does not treat a non-finished event with an implied outcome as dispatch evidence", () => {
    const opened = openedEvent({ outcome: "SUCCEEDED" });
    const weirdFinished = createPrimaryEvent({
      schema_version: 1,
      record_type: "attempt_finished",
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
      outcome: "WEIRD",
    });
    assert.equal(opened.ok && weirdFinished.ok, true);
    if (!opened.ok || !weirdFinished.ok) {
      throw new Error("events");
    }
    assert.equal(classifyDispatch([opened.value], ATTEMPT), "UNKNOWN");
    assert.equal(attemptFromEvents([opened.value], ATTEMPT)?.outcome, "FAILED");
    assert.equal(classifyDispatch([weirdFinished.value], ATTEMPT), "UNKNOWN");
  });
});

describe("caller mutation: timer helpers", SUITE, () => {
  it("resolves a zero-duration wait on the microtask path", async () => {
    let done = false;
    const pending = waitDuration(0n, new AbortController().signal).then(() => {
      done = true;
    });
    await Promise.resolve();
    assert.equal(done, true);
    await pending;
  });

  it("rejects an aborted wait with the signal reason or a fallback error", async () => {
    const withReason = new AbortController();
    withReason.abort("deadline");
    await assert.rejects(() => waitDuration(1n, withReason.signal), (error: unknown) => error === "deadline");
    const empty = { aborted: true, reason: undefined } as AbortSignal;
    await assert.rejects(
      () => waitDuration(1n, empty),
      (error: unknown) => error instanceof Error && error.message === "aborted",
    );
    assert.equal(deadlineTimestamp(NOW), "2026-09-03T12:00:03.000Z");
  });

  it("rejects a live wait from abort without waiting out the duration", async () => {
    const live = new AbortController();
    const pending = waitDuration(2_000_000_000n, live.signal);
    live.abort("stop");
    await assert.rejects(() => pending, (error: unknown) => error === "stop");
  });
});
