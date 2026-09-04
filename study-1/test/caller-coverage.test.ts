import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APPLICATION_DEADLINE_NS,
  durationToMs,
  InMemoryCallerJournal,
  invokeAttempt,
  nextKnowledge,
  projectAttempts,
  projectKnowledge,
  waitDuration,
} from "../src/caller/index.ts";
import type { ProviderTransport, TransportResult } from "../src/caller/index.ts";
import { createPrimaryEvent } from "../src/protocol-records/index.ts";

const DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const TRIAL = "66666666-6666-4666-8666-666666666666";
const RUN = "33333333-3333-4333-8333-333333333333";
const ATTEMPT = "11111111-1111-4111-8111-111111111111";
const REQUEST = "77777777-7777-4777-8777-777777777777";
const SOURCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE_B = "abbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EVENT_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EVENT_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EVENT_C = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const EVENT_D = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NOW = "2026-09-03T12:00:00.000Z";

function request(): Record<string, unknown> {
  return {
    run_id: RUN,
    trial_id: TRIAL,
    trial_manifest_sha256: DIGEST,
    payment_id: "pay-poc-001",
    refund_request_id: "ref-poc-001",
    amount_minor: 10000,
    currency: "BRL",
  };
}

function hangTransport(): ProviderTransport {
  return {
    invoke: (_call, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  };
}

function accepted(): TransportResult {
  return {
    layer: "function",
    outcome: "accepted",
    provider_call_id: "99999999-9999-4999-8999-999999999999",
  };
}

describe("caller coverage seams", () => {
  it("writes nothing when pre-dispatch event construction fails after open", async () => {
    let calls = 0;
    const result = await invokeAttempt(request(), {
      journal: new InMemoryCallerJournal(),
      transport: hangTransport(),
      wall: {
        now: () => {
          calls += 1;
          return calls === 1 ? NOW : "not-a-timestamp";
        },
      },
      identities: {
        attempt_id: ATTEMPT,
        provider_request_id: REQUEST,
        source_instance_id: SOURCE,
      },
      event_ids: [EVENT_A, EVENT_B],
      pre_dispatch_failure: ["local_prepare_failed"],
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("pre-dispatch build");
    }
    assert.equal(result.value.events.length, 1);
    assert.equal(result.value.attempt.dispatch_state, "UNKNOWN");
  });

  it("does not classify TIMED_OUT when the timeout append does not land", async () => {
    const journal = new InMemoryCallerJournal();
    journal.skipNext(2);
    journal.failNext(2);
    let reads = 0;
    const result = await invokeAttempt(request(), {
      journal,
      transport: hangTransport(),
      timer: { wait: async () => undefined },
      wall: { now: () => NOW },
      monotonic: {
        nowNs: () => {
          reads += 1;
          return reads === 1 ? 0n : APPLICATION_DEADLINE_NS;
        },
      },
      identities: {
        attempt_id: ATTEMPT,
        provider_request_id: REQUEST,
        source_instance_id: SOURCE,
      },
      event_ids: [EVENT_A, EVENT_B, EVENT_C, EVENT_D],
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("timeout fail");
    }
    assert.equal(result.value.attempt.outcome, "FAILED");
    assert.equal(result.value.attempt.dispatch_state, "DISPATCHED");
    assert.equal(
      result.value.events.some((event) => event.record_type === "caller_timeout_recorded"),
      false,
    );
  });

  it("orders mixed source instances and refuses appends after stop", () => {
    const journal = new InMemoryCallerJournal();
    const first = createPrimaryEvent({
      schema_version: 1,
      record_type: "attempt_opened",
      event_id: EVENT_A,
      occurred_at: NOW,
      source: "caller",
      source_instance_id: SOURCE_B,
      source_sequence: 1,
      trial_manifest_sha256: DIGEST,
      run_id: RUN,
      attempt_id: ATTEMPT,
      provider_request_id: REQUEST,
      refund_request_id: "ref-poc-001",
    });
    const second = createPrimaryEvent({
      schema_version: 1,
      record_type: "attempt_opened",
      event_id: EVENT_B,
      occurred_at: NOW,
      source: "caller",
      source_instance_id: SOURCE,
      source_sequence: 1,
      trial_manifest_sha256: DIGEST,
      run_id: RUN,
      attempt_id: "21111111-1111-4111-8111-111111111111",
      provider_request_id: "27777777-7777-4777-8777-777777777777",
      refund_request_id: "ref-poc-001",
    });
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) {
      throw new Error("events");
    }
    const third = createPrimaryEvent({
      schema_version: 1,
      record_type: "attempt_opened",
      event_id: EVENT_C,
      occurred_at: NOW,
      source: "caller",
      source_instance_id: "accccccc-cccc-4ccc-8ccc-cccccccccccc",
      source_sequence: 1,
      trial_manifest_sha256: DIGEST,
      run_id: RUN,
      attempt_id: "31111111-1111-4111-8111-111111111111",
      provider_request_id: "37777777-7777-4777-8777-777777777777",
      refund_request_id: "ref-poc-001",
    });
    assert.equal(third.ok, true);
    if (!third.ok) {
      throw new Error("third");
    }
    assert.equal(journal.append(first.value), "committed");
    assert.equal(journal.append(second.value), "committed");
    assert.equal(journal.append(third.value), "committed");
    assert.deepEqual(
      journal.list().map((event) => event.source_instance_id),
      [SOURCE, SOURCE_B, "accccccc-cccc-4ccc-8ccc-cccccccccccc"],
    );
    journal.ambiguousNext();
    assert.equal(journal.append(second.value), "ambiguous");
    assert.equal(journal.append(second.value), "failed");
    journal.skipNext();
    assert.equal(journal.isStopped(SOURCE), true);
  });

  it("keeps a confirmed effect when a later attempt is rejected", () => {
    const knowledge = projectKnowledge([
      {
        attempt_id: ATTEMPT,
        provider_request_id: REQUEST,
        refund_request_id: "ref-poc-001",
        outcome: "SUCCEEDED",
        dispatch_state: "DISPATCHED",
      },
      {
        attempt_id: "21111111-1111-4111-8111-111111111111",
        provider_request_id: "27777777-7777-4777-8777-777777777777",
        refund_request_id: "ref-poc-001",
        outcome: "REJECTED",
        dispatch_state: "DISPATCHED",
      },
    ]);
    assert.equal(knowledge, "ONE_EFFECT_CONFIRMED");
    assert.equal(
      nextKnowledge("NO_EFFECT_CONFIRMED", {
        attempt_id: ATTEMPT,
        provider_request_id: REQUEST,
        refund_request_id: "ref-poc-001",
        outcome: "REJECTED",
        dispatch_state: "DISPATCHED",
      }),
      "NO_EFFECT_CONFIRMED",
    );
  });

  it("fires waitDuration and clamps oversized millisecond conversions", async () => {
    await waitDuration(1_000_000n, new AbortController().signal);
    const aborted = { aborted: true, reason: undefined } as AbortSignal;
    await assert.rejects(() => waitDuration(1n, aborted));
    assert.equal(
      durationToMs((BigInt(Number.MAX_SAFE_INTEGER) + 1n) * 1_000_000n),
      Number.MAX_SAFE_INTEGER,
    );
    const result = await invokeAttempt(request(), {
      journal: new InMemoryCallerJournal(),
      transport: {
        invoke: async () => accepted(),
      },
    });
    assert.equal(result.ok, true);
    const thrown = await invokeAttempt(request(), {
      journal: new InMemoryCallerJournal(),
      transport: {
        invoke: async () => {
          throw "socket";
        },
      },
      timer: { wait: () => new Promise(() => undefined) },
    });
    assert.equal(thrown.ok, true);
    if (!thrown.ok) {
      throw new Error("thrown");
    }
    assert.equal(thrown.value.attempt.outcome, "FAILED");
  });

  it("drops an attempt that has a refund id but no provider request id", () => {
    const opened = createPrimaryEvent({
      schema_version: 1,
      record_type: "attempt_opened",
      event_id: EVENT_C,
      occurred_at: NOW,
      source: "caller",
      source_instance_id: SOURCE,
      source_sequence: 1,
      trial_manifest_sha256: DIGEST,
      run_id: RUN,
      attempt_id: ATTEMPT,
      refund_request_id: "ref-poc-001",
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) {
      throw new Error("opened");
    }
    assert.deepEqual(projectAttempts([opened.value]), []);
    const timeoutOnly = createPrimaryEvent({
      schema_version: 1,
      record_type: "caller_timeout_recorded",
      event_id: EVENT_D,
      occurred_at: NOW,
      source: "caller",
      source_instance_id: SOURCE,
      source_sequence: 2,
      trial_manifest_sha256: DIGEST,
      run_id: RUN,
      attempt_id: "31111111-1111-4111-8111-111111111111",
      provider_request_id: REQUEST,
      refund_request_id: "ref-poc-001",
    });
    assert.equal(timeoutOnly.ok, true);
    if (!timeoutOnly.ok) {
      throw new Error("timeout only");
    }
    const projected = projectAttempts([timeoutOnly.value]);
    assert.equal(projected.length, 1);
    assert.equal(projected[0]?.outcome, "TIMED_OUT");
  });
});
