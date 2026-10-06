// The provider's structured log (clean-code logging rule): one JSON line per event on stderr in
// Lambda, a recording fake in tests. Log lines are diagnostics, never evidence; the oracle reads
// only the journal. They exist so that nothing the provider tolerates goes unreported: a fault, an
// error that escapes the handler, and a treatment read the barrier could not use (WP-07 review
// round 0: failed reads were swallowed silently).

import type { ProviderFaultLog, ProviderUnexpectedErrorLog } from './provider-fault.ts';

/** A treatment read the barrier could not use; it keeps polling and decides on a later read. */
export interface TreatmentReadFailedLog {
  readonly level: 'warn';
  readonly event: 'treatment_read_failed';
  readonly provider_call_id: string;
  /** The store error code, or `UndecodableItem` for an item the provider cannot decode. */
  readonly code: string;
  readonly detail: string;
}

export type ProviderLogLine = ProviderFaultLog | ProviderUnexpectedErrorLog | TreatmentReadFailedLog;

/** Where log lines go: one JSON line on stderr in Lambda, a recorder in tests. */
export type ProviderLogSink = (line: ProviderLogLine) => void;

/**
 * A sink that writes each line as one JSON text followed by a newline.
 *
 * @example
 * const log = jsonLineLogSink((text) => process.stderr.write(text));
 * log(fault.toLog()); // '{"level":"error","event":"provider_fault",...}\n'
 */
export function jsonLineLogSink(write: (text: string) => void): ProviderLogSink {
  return (line) => {
    write(`${JSON.stringify(line)}\n`);
  };
}
