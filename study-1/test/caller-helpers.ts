import { InMemoryCallerJournal } from "../src/caller/index.ts";
import type { InvokePorts, ProviderTransport, TransportResult } from "../src/caller/index.ts";
import type { AttemptRecord } from "../src/caller/types.ts";

export const DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const TRIAL = "66666666-6666-4666-8666-666666666666";
export const RUN = "33333333-3333-4333-8333-333333333333";
export const PROBE = "44444444-4444-4444-8444-444444444444";
export const VALIDATION = "55555555-5555-4555-8555-555555555555";
export const ATTEMPT = "11111111-1111-4111-8111-111111111111";
export const REQUEST = "77777777-7777-4777-8777-777777777777";
export const SOURCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const EVENT_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const EVENT_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const EVENT_C = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const EVENT_D = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export const NOW = "2026-09-03T12:00:00.000Z";

export function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: RUN,
    trial_id: TRIAL,
    trial_manifest_sha256: DIGEST,
    payment_id: "pay-poc-001",
    refund_request_id: "ref-poc-001",
    amount_minor: 10000,
    currency: "BRL",
    ...overrides,
  };
}

export function accepted(): TransportResult {
  return {
    layer: "function",
    outcome: "accepted",
    provider_call_id: "99999999-9999-4999-8999-999999999999",
  };
}

export function rejected(): TransportResult {
  return {
    layer: "function",
    outcome: "rejected",
    provider_call_id: "99999999-9999-4999-8999-999999999999",
    reasons: ["inactive_execution"],
  };
}

export function functionFailed(): TransportResult {
  return { layer: "function", outcome: "failed", reasons: ["transact_failed"] };
}

export function hangTransport(): ProviderTransport {
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

export function resolveTransport(result: TransportResult): ProviderTransport & { calls: number } {
  const transport = {
    calls: 0,
    invoke: async () => {
      transport.calls += 1;
      return result;
    },
  };
  return transport;
}

export function rejectTransport(error: Error): ProviderTransport {
  return {
    invoke: async () => {
      throw error;
    },
  };
}

export function clocks(elapsedNs: bigint, times: string[] = [NOW, NOW, NOW, NOW, NOW, NOW, NOW]) {
  const remaining = [...times];
  let reads = 0;
  return {
    wall: {
      now: () => remaining.shift() ?? NOW,
    },
    monotonic: {
      nowNs: () => {
        const current = reads;
        reads += 1;
        return current === 0 ? 0n : elapsedNs;
      },
    },
  };
}

export function ports(
  overrides: Partial<InvokePorts> & { transport: ProviderTransport },
): InvokePorts {
  return {
    journal: new InMemoryCallerJournal(),
    timer: { wait: async () => undefined },
    wall: { now: () => NOW },
    monotonic: { nowNs: () => 0n },
    identities: {
      attempt_id: ATTEMPT,
      provider_request_id: REQUEST,
      source_instance_id: SOURCE,
    },
    event_ids: [EVENT_A, EVENT_B, EVENT_C, EVENT_D],
    ...overrides,
  };
}

export function attempt(
  outcome: AttemptRecord["outcome"],
  dispatch: AttemptRecord["dispatch_state"],
  id = ATTEMPT,
): AttemptRecord {
  return {
    attempt_id: id,
    provider_request_id: REQUEST,
    refund_request_id: "ref-poc-001",
    outcome,
    dispatch_state: dispatch,
  };
}
