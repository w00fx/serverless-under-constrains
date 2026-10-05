// Faults of the probe caller: what it cannot do without breaking the probe's evidence. An
// invalid workload request names no attempt to make, and a caller journal that cannot record
// the invocation start leaves the attempt without its cause (BR-RUA-027 cardinality). Both are
// thrown before any provider call, so the runner's single invocation fails visibly and nothing
// is retried (Lambda does not retry synchronous invokes).

export const PROBE_CALLER_FAULT_CODES = ['REQUEST_INVALID', 'JOURNAL_STOPPED'] as const;
export type ProbeCallerFaultCode = (typeof PROBE_CALLER_FAULT_CODES)[number];

/** The JSON log line of a fault (structured logging, clean-code rule). */
export interface ProbeCallerFaultLog {
  readonly level: 'error';
  readonly event: 'probe_caller_fault';
  readonly code: ProbeCallerFaultCode;
  readonly lambda_request_id: string;
  readonly detail: string;
}

export class ProbeCallerFault extends Error {
  readonly code: ProbeCallerFaultCode;
  readonly lambdaRequestId: string;

  /**
   * @example
   * throw new ProbeCallerFault('JOURNAL_STOPPED', requestId, 'caller_invocation_started not written: AMBIGUOUS_APPEND');
   */
  constructor(code: ProbeCallerFaultCode, lambdaRequestId: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'ProbeCallerFault';
    this.code = code;
    this.lambdaRequestId = lambdaRequestId;
  }

  /**
   * The structured log line the handler writes before it rethrows.
   *
   * @example
   * process.stderr.write(`${JSON.stringify(fault.toLog())}\n`);
   */
  toLog(): ProbeCallerFaultLog {
    return {
      level: 'error',
      event: 'probe_caller_fault',
      code: this.code,
      lambda_request_id: this.lambdaRequestId,
      detail: this.message,
    };
  }
}
