// Catalogue group B row 21 (design §6.2): the durable pre-dispatch registration of one
// physical attempt (BR-RUA-021, INV-RUA-001).

import type { EventEnvelope } from '../../envelope.ts';
import type { AttemptCorrelation } from './shared-shapes.ts';
import type { CallerEventSource } from './vocabulary.ts';

/** Schema: `schemas/group-b/attempt_registered.schema.json`. */
export interface AttemptRegistered extends EventEnvelope<'attempt_registered'>, AttemptCorrelation {
  readonly source: CallerEventSource;
  readonly payment_id: string;
  /** Safe-integer minor units, at least 1 (BR-RUA-033). */
  readonly amount_minor: number;
  /** ISO 4217 code; `BRL` in the PoC (OR-RUA-001). */
  readonly currency: string;
  /** The immutable provider version number the attempt invokes, never `$LATEST` or an alias. */
  readonly provider_qualifier: string;
}
