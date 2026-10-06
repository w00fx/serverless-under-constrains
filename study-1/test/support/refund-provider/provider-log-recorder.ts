// A named fake of the provider's log sink (design §12.2): it keeps every line the provider logs,
// in order, so a test can assert what a production sink would have written as JSON lines on
// stderr. Its conformance test is
// `test/integration/refund-provider/fakes/provider-log-recorder.conformance.integration.test.ts`.

import type { ProviderLogLine, ProviderLogSink } from '../../../src/refund-provider/provider-log.ts';

export class ProviderLogRecorder {
  readonly #lines: ProviderLogLine[] = [];

  /** The sink to hand to the provider. */
  readonly sink: ProviderLogSink = (line) => {
    this.#lines.push(line);
  };

  /** Every line logged so far, in order; a copy, so a reader cannot rewrite the record. */
  lines(): readonly ProviderLogLine[] {
    return [...this.#lines];
  }

  /** The `event` names of the logged lines, in order. */
  events(): readonly string[] {
    return this.#lines.map((line) => line.event);
  }
}
