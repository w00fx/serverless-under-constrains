// A named fake of the Durable handler's log sink (clean-code rule: named fakes, not inline stubs).
// Production writes each line to stderr as one JSON document; this fake keeps the lines in write
// order, as the JSON round trip would leave them, so a test asserts exactly what CloudWatch
// would receive.

import type { DurableLogLine, DurableLogSink } from '../../../../src/durable-variant/durable-refund-handler.ts';

export class RecordingDurableLogSink implements DurableLogSink {
  readonly #lines: DurableLogLine[] = [];

  /**
   * Records one line after a JSON round trip, the transformation stderr applies.
   *
   * @example
   * sink.write(fault.toLog()); sink.lines(); // [{ level: 'error', event: 'durable_caller_fault', ... }]
   */
  write(line: DurableLogLine): void {
    this.#lines.push(JSON.parse(JSON.stringify(line)) as DurableLogLine);
  }

  /** Every line written so far, oldest first. */
  lines(): readonly DurableLogLine[] {
    return [...this.#lines];
  }

  /** The `event` of every line, oldest first. */
  events(): readonly DurableLogLine['event'][] {
    return this.#lines.map((line) => line.event);
  }
}
