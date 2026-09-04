import type { PrimaryEvent } from "../protocol-records/types.ts";
import type { ValidationResult } from "../protocol-records/types.ts";
import { fail, isRecord, ok } from "../protocol-records/primitives.ts";
import type {
  AttemptOutcome,
  AttemptRecord,
  DispatchState,
  EffectKnowledgeState,
  ProcessingProjection,
  RetryEnvelope,
} from "./types.ts";

const IMPLIED_DISPATCHED = new Set<AttemptOutcome>(["SUCCEEDED", "REJECTED", "TIMED_OUT"]);

function eventsForAttempt(events: readonly PrimaryEvent[], attemptId: string): PrimaryEvent[] {
  return events.filter((event) => event.attempt_id === attemptId);
}

function isAttemptOutcome(value: unknown): value is AttemptOutcome {
  return (
    value === "SUCCEEDED" || value === "REJECTED" || value === "TIMED_OUT" || value === "FAILED"
  );
}

export function hasDispatchEvidence(events: readonly PrimaryEvent[], attemptId: string): boolean {
  for (const event of eventsForAttempt(events, attemptId)) {
    if (event.record_type === "dispatch_started") {
      return true;
    }
    if (event.record_type === "caller_timeout_recorded") {
      return true;
    }
    if (
      event.record_type === "attempt_finished" &&
      isAttemptOutcome(event.outcome) &&
      IMPLIED_DISPATCHED.has(event.outcome)
    ) {
      return true;
    }
  }
  return false;
}

export function isStillPreDispatch(events: readonly PrimaryEvent[], attemptId: string): boolean {
  return !hasDispatchEvidence(events, attemptId);
}

export function classifyDispatch(events: readonly PrimaryEvent[], attemptId: string): DispatchState {
  if (hasDispatchEvidence(events, attemptId)) {
    return "DISPATCHED";
  }
  const mine = eventsForAttempt(events, attemptId);
  if (mine.some((event) => event.record_type === "pre_dispatch_failed")) {
    return "NOT_DISPATCHED";
  }
  return "UNKNOWN";
}

function classifyOutcome(events: readonly PrimaryEvent[], attemptId: string): AttemptOutcome {
  const mine = eventsForAttempt(events, attemptId);
  for (let index = mine.length - 1; index >= 0; index -= 1) {
    const event = mine[index]!;
    if (event.record_type === "attempt_finished" && isAttemptOutcome(event.outcome)) {
      return event.outcome;
    }
  }
  if (mine.some((event) => event.record_type === "caller_timeout_recorded")) {
    return "TIMED_OUT";
  }
  return "FAILED";
}

export function attemptFromEvents(
  events: readonly PrimaryEvent[],
  attemptId: string,
): AttemptRecord | undefined {
  const mine = eventsForAttempt(events, attemptId);
  if (mine.length === 0) {
    return undefined;
  }
  const opened = mine.find((event) => event.record_type === "attempt_opened") ?? mine[0]!;
  if (typeof opened.refund_request_id !== "string" || typeof opened.provider_request_id !== "string") {
    return undefined;
  }
  return {
    attempt_id: attemptId,
    provider_request_id: opened.provider_request_id,
    refund_request_id: opened.refund_request_id,
    outcome: classifyOutcome(events, attemptId),
    dispatch_state: classifyDispatch(events, attemptId),
  };
}

export function projectAttempts(events: readonly PrimaryEvent[]): AttemptRecord[] {
  const records: AttemptRecord[] = [];
  for (const event of events) {
    if (typeof event.attempt_id !== "string") {
      continue;
    }
    if (records.some((record) => record.attempt_id === event.attempt_id)) {
      continue;
    }
    const record = attemptFromEvents(events, event.attempt_id);
    if (record !== undefined) {
      records.push(record);
    }
  }
  return records;
}

function nextFailedKnowledge(
  current: EffectKnowledgeState,
  dispatchState: DispatchState,
): EffectKnowledgeState {
  if (dispatchState === "NOT_DISPATCHED") {
    return current;
  }
  return "UNKNOWN";
}

function nextSuccessKnowledge(current: EffectKnowledgeState): EffectKnowledgeState {
  if (current === "ONE_EFFECT_CONFIRMED" || current === "MULTIPLE_EFFECTS_CONFIRMED") {
    return "MULTIPLE_EFFECTS_CONFIRMED";
  }
  return "ONE_EFFECT_CONFIRMED";
}

function nextRejectedKnowledge(current: EffectKnowledgeState): EffectKnowledgeState {
  if (current === "NOT_ATTEMPTED") {
    return "NO_EFFECT_CONFIRMED";
  }
  return current;
}

export function nextKnowledge(
  current: EffectKnowledgeState,
  attempt: AttemptRecord,
): EffectKnowledgeState {
  if (current === "UNKNOWN") {
    return "UNKNOWN";
  }
  switch (attempt.outcome) {
    case "TIMED_OUT":
      return "UNKNOWN";
    case "FAILED":
      return nextFailedKnowledge(current, attempt.dispatch_state);
    case "SUCCEEDED":
      return nextSuccessKnowledge(current);
    case "REJECTED":
      return nextRejectedKnowledge(current);
  }
}

export function projectKnowledge(attempts: readonly AttemptRecord[]): EffectKnowledgeState {
  let state: EffectKnowledgeState = "NOT_ATTEMPTED";
  for (const attempt of attempts) {
    state = nextKnowledge(state, attempt);
  }
  return state;
}

function isNonnegativeSafeInteger(candidate: unknown): candidate is number {
  if (!Number.isSafeInteger(candidate)) {
    return false;
  }
  return Number(candidate) >= 0;
}

export function createRetryEnvelope(input: unknown): ValidationResult<RetryEnvelope> {
  if (!isRecord(input)) {
    return fail(["not_an_object"]);
  }
  if (!isNonnegativeSafeInteger(input.inner_remaining) || !isNonnegativeSafeInteger(input.upstream_remaining)) {
    return fail(["invalid_retry_envelope"]);
  }
  return ok({
    inner_remaining: input.inner_remaining,
    upstream_remaining: input.upstream_remaining,
  });
}

function remainingLayers(envelope: RetryEnvelope): number {
  return envelope.inner_remaining + envelope.upstream_remaining;
}

export function projectProcessing(
  attempts: readonly AttemptRecord[],
  envelopeInput: unknown,
): ValidationResult<ProcessingProjection> {
  const envelope = createRetryEnvelope(envelopeInput);
  if (!envelope.ok) {
    return envelope;
  }
  if (attempts.length === 0) {
    return ok({ processing_state: "NOT_STARTED" });
  }
  if (attempts.some((attempt) => attempt.outcome === "SUCCEEDED")) {
    return ok({ processing_state: "FINISHED", processing_terminal_reason: "SUCCEEDED" });
  }
  if (remainingLayers(envelope.value) > 0) {
    return ok({ processing_state: "RUNNING" });
  }
  const last = attempts[attempts.length - 1]!;
  if (last.outcome === "REJECTED") {
    return ok({ processing_state: "FINISHED", processing_terminal_reason: "PROVIDER_REJECTED" });
  }
  return ok({ processing_state: "FINISHED", processing_terminal_reason: "RETRIES_EXHAUSTED" });
}
