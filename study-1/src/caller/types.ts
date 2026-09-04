import type { RefundCall } from "../controlled-provider/types.ts";
import type { PrimaryEvent } from "../protocol-records/types.ts";

export const APPLICATION_DEADLINE_NS = 3_000_000_000n;

export type AttemptOutcome = "SUCCEEDED" | "REJECTED" | "TIMED_OUT" | "FAILED";
export type DispatchState = "NOT_DISPATCHED" | "DISPATCHED" | "UNKNOWN";
export type ProcessingState = "NOT_STARTED" | "RUNNING" | "FINISHED";
export type ProcessingTerminalReason =
  | "SUCCEEDED"
  | "RETRIES_EXHAUSTED"
  | "MESSAGE_REJECTED"
  | "PROVIDER_REJECTED"
  | "INTERRUPTED"
  | "SAFETY_DEADLINE";
export type EffectKnowledgeState =
  | "NOT_ATTEMPTED"
  | "NO_EFFECT_CONFIRMED"
  | "ONE_EFFECT_CONFIRMED"
  | "MULTIPLE_EFFECTS_CONFIRMED"
  | "UNKNOWN";

export type RetryEnvelope = {
  inner_remaining: number;
  upstream_remaining: number;
};

export type AttemptRecord = {
  attempt_id: string;
  provider_request_id: string;
  refund_request_id: string;
  outcome: AttemptOutcome;
  dispatch_state: DispatchState;
};

export type ProcessingProjection = {
  processing_state: ProcessingState;
  processing_terminal_reason?: ProcessingTerminalReason;
};

export type JournalAppendResult = "committed" | "failed" | "ambiguous";

export type FunctionAccepted = {
  layer: "function";
  outcome: "accepted";
  provider_call_id: string;
};

export type FunctionRejected = {
  layer: "function";
  outcome: "rejected";
  provider_call_id: string;
  reasons: readonly string[];
};

export type FunctionFailed = {
  layer: "function";
  outcome: "failed";
  reasons: readonly string[];
  provider_call_id?: string;
};

export type TransportFault = {
  layer: "transport";
  kind: "error" | "aborted";
  reasons: readonly string[];
};

export type TransportResult = FunctionAccepted | FunctionRejected | FunctionFailed | TransportFault;

export type ProviderTransport = {
  invoke(request: RefundCall, signal: AbortSignal): Promise<TransportResult>;
};

export type WallClock = {
  now(): string;
};

export type MonotonicClock = {
  nowNs(): bigint;
};

export type TimerPort = {
  wait(durationNs: bigint, signal: AbortSignal): Promise<void>;
};

export type CallerJournal = {
  isStopped(sourceInstanceId: string): boolean;
  peekSequence(sourceInstanceId: string): number;
  list(): PrimaryEvent[];
  append(event: PrimaryEvent): JournalAppendResult;
  appendConditional(
    event: PrimaryEvent,
    predicate: (events: readonly PrimaryEvent[]) => boolean,
  ): JournalAppendResult;
};

export type AttemptIdentities = {
  refund_request_id: string;
  attempt_id: string;
  provider_request_id: string;
};

export type InvokeSuccess = {
  attempt: AttemptRecord;
  events: readonly PrimaryEvent[];
};

export type InvokePorts = {
  transport: ProviderTransport;
  journal: CallerJournal;
  wall?: WallClock;
  monotonic?: MonotonicClock;
  timer?: TimerPort;
  identities?: {
    attempt_id?: string;
    provider_request_id?: string;
    source_instance_id?: string;
  };
  event_ids?: string[];
  pre_dispatch_failure?: readonly string[];
};
