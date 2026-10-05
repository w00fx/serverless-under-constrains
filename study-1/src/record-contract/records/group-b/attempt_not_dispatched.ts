// Catalogue group B row 22 (design §6.2): the conditional PRE_DISPATCH -> NOT_DISPATCHED
// transition that alone proves non-dispatch (BR-RUA-021, AC-RUA-015).

import type { EventEnvelope } from '../../envelope.ts';
import type { StructuredReason } from '../../primitives.ts';
import type { AttemptCorrelation } from './shared-shapes.ts';
import type { CallerEventSource, PreDispatchFailureCode } from './vocabulary.ts';

/** Schema: `schemas/group-b/attempt_not_dispatched.schema.json`. */
export interface AttemptNotDispatched extends EventEnvelope<'attempt_not_dispatched'>, AttemptCorrelation {
  readonly source: CallerEventSource;
  readonly failure: StructuredReason & { readonly code: PreDispatchFailureCode };
}
