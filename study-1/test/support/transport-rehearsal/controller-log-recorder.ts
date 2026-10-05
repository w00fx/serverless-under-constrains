// A recording sink for the controller's structured log lines (the Lambda handler writes them to
// stdout). Tests and the transport rehearsal read what the controller logged per stream record.

import type { ControllerLogLine } from '../../../src/treatment-controller/stream-consumer.ts';

export class ControllerLogRecorder {
  readonly #lines: ControllerLogLine[] = [];

  /** The sink to pass to `consumeStreamEvent`. */
  readonly sink = (line: ControllerLogLine): void => {
    this.#lines.push(line);
  };

  /** Every line logged so far, in order. */
  lines(): readonly ControllerLogLine[] {
    return [...this.#lines];
  }

  /** The `outcome` of every handled record, in order. */
  handledOutcomes(): readonly string[] {
    return this.#lines.flatMap((line) => (line.event === 'controller_record_handled' ? [line.outcome] : []));
  }
}
