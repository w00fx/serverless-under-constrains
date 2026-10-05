// Operational faults of the controller. A domain outcome of the §9.11 table is journaled and
// returned, never thrown, so the stream mapping does not retry it. A fault is what the
// controller cannot decide or cannot record: unreadable control state, a journal instance that
// stopped (ambiguous append), or a signal transaction whose result is unknown or definitively
// failed. Throwing it fails the invocation, so the event source mapping retries the record a
// bounded number of times (MaximumRetryAttempts 2) and then sends it to the failure queue.

export const CONTROLLER_FAULT_CODES = [
  'STATE_UNREADABLE',
  'JOURNAL_STOPPED',
  'SIGNAL_AMBIGUOUS',
  'SIGNAL_FAILED',
  'SIGNAL_REDECIDED_TO_SIGNAL',
] as const;
export type ControllerFaultCode = (typeof CONTROLLER_FAULT_CODES)[number];

/** The JSON log line of a fault (structured logging, clean-code rule). */
export interface ControllerFaultLog {
  readonly level: 'error';
  readonly event: 'controller_fault';
  readonly code: ControllerFaultCode;
  readonly partition_key: string;
  readonly detail: string;
}

export class ControllerFault extends Error {
  readonly code: ControllerFaultCode;
  readonly partitionKey: string;

  /**
   * @example
   * throw new ControllerFault('SIGNAL_AMBIGUOUS', partition.key, 'signal transaction TimeoutError; expected applied');
   */
  constructor(code: ControllerFaultCode, partitionKey: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'ControllerFault';
    this.code = code;
    this.partitionKey = partitionKey;
  }

  /**
   * The structured log line written before the invocation fails.
   *
   * @example
   * process.stderr.write(`${JSON.stringify(fault.toLog())}\n`);
   */
  toLog(): ControllerFaultLog {
    return {
      level: 'error',
      event: 'controller_fault',
      code: this.code,
      partition_key: this.partitionKey,
      detail: this.message,
    };
  }
}
