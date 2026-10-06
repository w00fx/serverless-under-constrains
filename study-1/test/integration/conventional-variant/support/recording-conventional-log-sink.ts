// A named fake of the conventional Lambda entry's log sink (clean-code rule: named fakes, not
// inline stubs). Production writes each line to stderr as one JSON document; this fake keeps the
// lines in write order, as the JSON round trip would leave them, so a test asserts exactly what
// CloudWatch would receive.

import type {
  ConventionalLogLine,
  ConventionalLogSink,
} from '../../../../src/conventional-variant/conventional-lambda-entry.ts';

export class RecordingConventionalLogSink implements ConventionalLogSink {
  readonly #lines: ConventionalLogLine[] = [];

  /**
   * Records one line after a JSON round trip, the transformation stderr applies.
   *
   * @example
   * sink.write(fault.toLog()); sink.lines(); // [{ level: 'error', event: 'conventional_caller_fault', ... }]
   */
  write(line: ConventionalLogLine): void {
    this.#lines.push(JSON.parse(JSON.stringify(line)) as ConventionalLogLine);
  }

  /** Every line written so far, oldest first. */
  lines(): readonly ConventionalLogLine[] {
    return [...this.#lines];
  }

  /** The `event` of every line, oldest first. */
  events(): readonly ConventionalLogLine['event'][] {
    return this.#lines.map((line) => line.event);
  }
}
