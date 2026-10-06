// Operational faults of the provider. A business outcome (SUCCEEDED or REJECTED) is a
// response; a fault is thrown, so Lambda returns a function error and the caller classifies
// the attempt as FAILED/DISPATCHED (design §9.9), never as a provider answer. Faults cover
// what the provider cannot decide or cannot record (D-20, D-23): unreadable state, a call it
// cannot attribute to a configured partition, a definitive or ambiguous commit, and a source
// instance that stopped emitting events.

export const PROVIDER_FAULT_CODES = [
  'UNATTRIBUTABLE_CALL',
  'CONFIGURATION_MISSING',
  'STATE_UNREADABLE',
  'JOURNAL_STOPPED',
  'COMMIT_FAILED',
  'COMMIT_AMBIGUOUS',
  'TREATMENT_UNEXPECTED',
  'TRANSITION_AMBIGUOUS',
  'WARMUP_REQUEST_INVALID',
] as const;
export type ProviderFaultCode = (typeof PROVIDER_FAULT_CODES)[number];

/** Whether the ledger transaction exists when the fault happens (D-20): no, unknown, or yes. */
export type FaultPhase = 'before_commit' | 'commit_unknown' | 'after_commit';

/** The JSON log line of a fault (structured logging, clean-code rule). */
export interface ProviderFaultLog {
  readonly level: 'error';
  readonly event: 'provider_fault';
  readonly code: ProviderFaultCode;
  readonly phase: FaultPhase;
  readonly provider_call_id: string | null;
  readonly detail: string;
}

export class ProviderFault extends Error {
  readonly code: ProviderFaultCode;
  readonly phase: FaultPhase;
  readonly providerCallId: string | undefined;

  /**
   * @example
   * throw new ProviderFault('COMMIT_AMBIGUOUS', 'before_commit', callId, 'commit outcome TimeoutError; expected applied');
   */
  constructor(code: ProviderFaultCode, phase: FaultPhase, providerCallId: string | undefined, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'ProviderFault';
    this.code = code;
    this.phase = phase;
    this.providerCallId = providerCallId;
  }

  /**
   * The structured log line the handler writes before it rethrows.
   *
   * @example
   * process.stderr.write(`${JSON.stringify(fault.toLog())}\n`);
   */
  toLog(): ProviderFaultLog {
    return {
      level: 'error',
      event: 'provider_fault',
      code: this.code,
      phase: this.phase,
      provider_call_id: this.providerCallId ?? null,
      detail: this.message,
    };
  }
}

/** The JSON log line of any other error that escapes the handler, such as an environment refusal. */
export interface ProviderUnexpectedErrorLog {
  readonly level: 'error';
  readonly event: 'provider_unexpected_error';
  readonly error_name: string;
  readonly detail: string;
}

/**
 * The structured log line of an error that is not a ProviderFault, so no failure leaves the
 * handler unlogged (WP-07 review round 1). A thrown non-Error value is described by its type.
 *
 * @example
 * unexpectedErrorLog(new TypeError('boom')); // { level: 'error', event: 'provider_unexpected_error', error_name: 'TypeError', detail: 'boom' }
 */
export function unexpectedErrorLog(error: unknown): ProviderUnexpectedErrorLog {
  if (error instanceof Error) {
    return { level: 'error', event: 'provider_unexpected_error', error_name: error.name, detail: error.message };
  }
  return {
    level: 'error',
    event: 'provider_unexpected_error',
    error_name: typeof error,
    detail: 'a thrown value that is not an Error',
  };
}
