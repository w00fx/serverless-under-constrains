import type { TransportResult } from "./types.ts";

export type TimerWin = {
  winner: "timer";
  elapsed_ns: bigint;
  fired_at: string;
};

export type TransportWin = {
  winner: "transport";
  result: TransportResult;
  elapsed_ns: bigint;
};

export type Settlement = TimerWin | TransportWin;

export function createArbiter(): { settle(value: Settlement): Settlement | undefined } {
  let taken = false;
  return {
    settle(value: Settlement): Settlement | undefined {
      if (taken) {
        return undefined;
      }
      taken = true;
      return value;
    },
  };
}

export function waitDuration(durationNs: bigint, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  if (durationNs <= 0n) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(handle);
      reject(abortReason(signal));
    };
    const handle = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationToMs(durationNs));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function durationToMs(durationNs: bigint): number {
  const ms = durationNs / 1_000_000n;
  if (ms > BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Number(ms);
}

export function deadlineTimestamp(dispatchedAt: string): string {
  const parsed = Date.parse(dispatchedAt);
  if (!Number.isFinite(parsed)) {
    return dispatchedAt;
  }
  return new Date(parsed + 3000).toISOString();
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason !== undefined ? signal.reason : new Error("aborted");
}
