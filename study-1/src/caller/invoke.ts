import { randomUUID } from "node:crypto";
import type { RefundCall } from "../controlled-provider/types.ts";
import { createRefundCall } from "../controlled-provider/refund-call.ts";
import { fail, isRecord, isUuidV4, ok } from "../protocol-records/primitives.ts";
import type { PrimaryEvent, ValidationResult } from "../protocol-records/types.ts";
import { createArbiter, deadlineTimestamp, waitDuration } from "./arbiter.ts";
import type { Settlement, TimerWin } from "./arbiter.ts";
import { buildCallerEvent, finishedExtra } from "./events.ts";
import { createAttemptIdentities } from "./identities.ts";
import {
  attemptFromEvents,
  classifyDispatch,
  isStillPreDispatch,
} from "./knowledge.ts";
import type {
  AttemptOutcome,
  AttemptRecord,
  CallerJournal,
  InvokePorts,
  InvokeSuccess,
  TransportResult,
} from "./types.ts";
import { APPLICATION_DEADLINE_NS } from "./types.ts";

type InvokeContext = {
  journal: CallerJournal;
  transport: InvokePorts["transport"];
  wall: { now(): string };
  monotonic: { nowNs(): bigint };
  timer: { wait(durationNs: bigint, signal: AbortSignal): Promise<void> };
  eventIds: string[];
  sourceInstanceId: string;
  call: RefundCall;
};

function takeEventId(eventIds: string[]): string {
  return eventIds.shift() ?? randomUUID();
}

function defaultWall(): { now(): string } {
  return { now: () => new Date().toISOString() };
}

function defaultMonotonic(): { nowNs(): bigint } {
  return { nowNs: () => process.hrtime.bigint() };
}

function defaultTimer(): { wait(durationNs: bigint, signal: AbortSignal): Promise<void> } {
  return { wait: waitDuration };
}

function appendOnce(journal: CallerJournal, event: PrimaryEvent): PrimaryEvent | undefined {
  const first = journal.append(event);
  if (first === "committed") {
    return event;
  }
  if (first === "ambiguous") {
    return undefined;
  }
  return journal.append(event) === "committed" ? event : undefined;
}

function snapshot(ctx: InvokeContext): InvokeSuccess {
  const attemptId = ctx.call.attempt_id;
  const events = ctx.journal.list().filter((event) => event.attempt_id === attemptId);
  const attempt = attemptFromEvents(ctx.journal.list(), attemptId);
  return {
    attempt: attempt ?? unknownAttempt(ctx.call),
    events,
  };
}

function unknownAttempt(call: RefundCall): AttemptRecord {
  return {
    attempt_id: call.attempt_id,
    provider_request_id: call.provider_request_id,
    refund_request_id: call.refund_request_id,
    outcome: "FAILED",
    dispatch_state: "UNKNOWN",
  };
}

function parseInvoke(request: unknown, ports: InvokePorts): ValidationResult<InvokeContext> {
  if (!isRecord(request)) {
    return fail(["not_an_object"]);
  }
  const minted = createAttemptIdentities({
    refund_request_id: request.refund_request_id,
    attempt_id: ports.identities?.attempt_id,
    provider_request_id: ports.identities?.provider_request_id,
  });
  if (!minted.ok) {
    return minted;
  }
  const call = createRefundCall({
    schema_version: 1,
    record_type: "refund_call",
    trial_id: request.trial_id,
    trial_manifest_sha256: request.trial_manifest_sha256,
    attempt_id: minted.value.attempt_id,
    provider_request_id: minted.value.provider_request_id,
    payment_id: request.payment_id,
    refund_request_id: minted.value.refund_request_id,
    amount_minor: request.amount_minor,
    currency: request.currency,
    run_id: request.run_id,
    transport_probe_id: request.transport_probe_id,
    variant_validation_id: request.variant_validation_id,
  });
  if (!call.ok) {
    return call;
  }
  const sourceInstanceId = ports.identities?.source_instance_id;
  if (sourceInstanceId !== undefined && !isUuidV4(sourceInstanceId)) {
    return fail(["invalid_uuid"]);
  }
  return ok({
    journal: ports.journal,
    transport: ports.transport,
    wall: ports.wall ?? defaultWall(),
    monotonic: ports.monotonic ?? defaultMonotonic(),
    timer: ports.timer ?? defaultTimer(),
    eventIds: ports.event_ids === undefined ? [] : [...ports.event_ids],
    sourceInstanceId: sourceInstanceId ?? randomUUID(),
    call: call.value,
  });
}

function writeEvent(
  ctx: InvokeContext,
  recordType: string,
  causation: readonly string[] | undefined,
  extra?: Record<string, unknown>,
): PrimaryEvent | undefined {
  const sequence = ctx.journal.peekSequence(ctx.sourceInstanceId);
  const built = buildCallerEvent({
    record_type: recordType,
    event_id: takeEventId(ctx.eventIds),
    occurred_at: ctx.wall.now(),
    source_instance_id: ctx.sourceInstanceId,
    source_sequence: sequence,
    call: ctx.call,
    causation_event_ids: causation,
    extra,
  });
  if (!built.ok) {
    return undefined;
  }
  return appendOnce(ctx.journal, built.value);
}

function writeFinished(
  ctx: InvokeContext,
  outcome: AttemptOutcome,
  causation: readonly string[],
): InvokeSuccess {
  const dispatchState = classifyDispatch(ctx.journal.list(), ctx.call.attempt_id);
  writeEvent(ctx, "attempt_finished", causation, finishedExtra(outcome, dispatchState));
  return snapshot(ctx);
}

function openAttempt(ctx: InvokeContext): PrimaryEvent | undefined {
  return writeEvent(ctx, "attempt_opened", undefined);
}

function failPreDispatch(ctx: InvokeContext, opened: PrimaryEvent, reasons: readonly string[]): InvokeSuccess {
  const failed = writeConditionalPreDispatch(ctx, opened, reasons);
  if (failed === undefined) {
    return snapshot(ctx);
  }
  return writeFinished(ctx, "FAILED", [failed.event_id]);
}

function writeConditionalPreDispatch(
  ctx: InvokeContext,
  opened: PrimaryEvent,
  reasons: readonly string[],
): PrimaryEvent | undefined {
  const sequence = ctx.journal.peekSequence(ctx.sourceInstanceId);
  const built = buildCallerEvent({
    record_type: "pre_dispatch_failed",
    event_id: takeEventId(ctx.eventIds),
    occurred_at: ctx.wall.now(),
    source_instance_id: ctx.sourceInstanceId,
    source_sequence: sequence,
    call: ctx.call,
    causation_event_ids: [opened.event_id],
    extra: { reasons },
  });
  if (!built.ok) {
    return undefined;
  }
  const attemptId = ctx.call.attempt_id;
  const predicate = (events: readonly PrimaryEvent[]): boolean =>
    isStillPreDispatch(events, attemptId);
  const first = ctx.journal.appendConditional(built.value, predicate);
  if (first === "committed") {
    return built.value;
  }
  if (first === "ambiguous") {
    return undefined;
  }
  return ctx.journal.appendConditional(built.value, predicate) === "committed"
    ? built.value
    : undefined;
}

function interpretTransport(result: unknown): AttemptOutcome {
  if (!isRecord(result) || result.layer !== "function") {
    return "FAILED";
  }
  if (result.outcome === "accepted") {
    return "SUCCEEDED";
  }
  if (result.outcome === "rejected") {
    return "REJECTED";
  }
  return "FAILED";
}

function transportFault(error: unknown): TransportResult {
  const name = error instanceof Error ? error.name : "";
  return {
    layer: "transport",
    kind: name === "AbortError" ? "aborted" : "error",
    reasons: [name === "AbortError" ? "aborted" : "transport_error"],
  };
}

function raceDeadline(ctx: InvokeContext, originNs: bigint): Promise<Settlement> {
  const arbiter = createArbiter();
  const transportAbort = new AbortController();
  const timerAbort = new AbortController();
  return new Promise((resolve) => {
    const deliver = (settlement: Settlement): void => {
      const won = arbiter.settle(settlement);
      if (won === undefined) {
        return;
      }
      if (won.winner === "timer") {
        transportAbort.abort();
      } else {
        timerAbort.abort();
      }
      resolve(won);
    };
    ctx.timer.wait(APPLICATION_DEADLINE_NS, timerAbort.signal).then(
      () => {
        const elapsed = ctx.monotonic.nowNs() - originNs;
        if (elapsed >= APPLICATION_DEADLINE_NS) {
          deliver({ winner: "timer", elapsed_ns: elapsed, fired_at: ctx.wall.now() });
        }
      },
      () => undefined,
    );
    ctx.transport.invoke(ctx.call, transportAbort.signal).then(
      (result) => {
        deliver({
          winner: "transport",
          result,
          elapsed_ns: ctx.monotonic.nowNs() - originNs,
        });
      },
      (error: unknown) => {
        deliver({
          winner: "transport",
          result: transportFault(error),
          elapsed_ns: ctx.monotonic.nowNs() - originNs,
        });
      },
    );
  });
}

function recordTimeout(
  ctx: InvokeContext,
  dispatchEvent: PrimaryEvent,
  win: TimerWin,
  dispatchedAt: string,
): InvokeSuccess {
  const abortRequestedAt = ctx.wall.now();
  const timeoutRecordedAt = ctx.wall.now();
  const timeout = writeEvent(ctx, "caller_timeout_recorded", [dispatchEvent.event_id], {
    elapsed_monotonic_ns: win.elapsed_ns.toString(),
    monotonic_origin_event_id: dispatchEvent.event_id,
    dispatched_at: dispatchedAt,
    deadline_at: deadlineTimestamp(dispatchedAt),
    timer_fired_at: win.fired_at,
    abort_requested_at: abortRequestedAt,
    timeout_recorded_at: timeoutRecordedAt,
  });
  if (timeout === undefined) {
    return snapshot(ctx);
  }
  return writeFinished(ctx, "TIMED_OUT", [timeout.event_id]);
}

async function settleDispatched(ctx: InvokeContext, dispatchEvent: PrimaryEvent): Promise<InvokeSuccess> {
  const originNs = ctx.monotonic.nowNs();
  const dispatchedAt = ctx.wall.now();
  const settlement = await raceDeadline(ctx, originNs);
  if (settlement.winner === "timer") {
    return recordTimeout(ctx, dispatchEvent, settlement, dispatchedAt);
  }
  const outcome = interpretTransport(settlement.result);
  return writeFinished(ctx, outcome, [dispatchEvent.event_id]);
}

/**
 * Execute one physical caller attempt: open, optional pre-dispatch failure,
 * dispatch, one-winner deadline arbitration, and journalled outcome.
 *
 * @example
 * await invokeAttempt(request, { transport, journal })
 */
export async function invokeAttempt(
  request: unknown,
  ports: InvokePorts,
): Promise<ValidationResult<InvokeSuccess>> {
  const parsed = parseInvoke(request, ports);
  if (!parsed.ok) {
    return parsed;
  }
  const ctx = parsed.value;
  if (ctx.journal.isStopped(ctx.sourceInstanceId)) {
    return fail(["source_instance_stopped"]);
  }
  const opened = openAttempt(ctx);
  if (opened === undefined) {
    return ok(snapshot(ctx));
  }
  if (ports.pre_dispatch_failure !== undefined) {
    return ok(failPreDispatch(ctx, opened, ports.pre_dispatch_failure));
  }
  const dispatched = writeEvent(ctx, "dispatch_started", [opened.event_id]);
  if (dispatched === undefined) {
    return ok(snapshot(ctx));
  }
  return ok(await settleDispatched(ctx, dispatched));
}
