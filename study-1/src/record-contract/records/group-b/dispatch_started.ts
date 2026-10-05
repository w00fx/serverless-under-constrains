// Catalogue group B row 23 (design §6.2): the dispatch boundary and monotonic origin of an
// attempt (BR-RUA-021, BR-RUA-023).

import type { EventEnvelope } from '../../envelope.ts';
import type { DecimalString, UtcMillis } from '../../primitives.ts';
import type { AttemptCorrelation } from './shared-shapes.ts';
import type { CallerEventSource } from './vocabulary.ts';

/** Schema: `schemas/group-b/dispatch_started.schema.json`. */
export interface DispatchStarted extends EventEnvelope<'dispatch_started'>, AttemptCorrelation {
  readonly source: CallerEventSource;
  /** Diagnostic wall time; ordering decisions use source-local monotonic time. */
  readonly dispatch_at: UtcMillis;
  readonly deadline_at: UtcMillis;
  /** The application deadline in nanoseconds (3000000000 in the PoC). */
  readonly deadline_ns: DecimalString;
}
