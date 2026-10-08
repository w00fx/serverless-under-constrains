// Addendum §2 (D-27 resolution): the provider handled one warm-up request in the execution
// partition `<execution_id>#warmup`, outside every trial. Readiness evidence only.

import type { EventEnvelope } from '../../envelope.ts';
import type { DecimalString, Uuid4, UtcMillis } from '../../primitives.ts';

/** Schema: `schemas/group-b/provider_warmup_completed.schema.json`. */
export interface ProviderWarmupCompleted extends EventEnvelope<'provider_warmup_completed'> {
  readonly source: 'refund_provider';
  readonly trial_id?: never;
  readonly trial_manifest_sha256?: never;
  readonly provider_call_id: Uuid4;
  readonly warmup_id: Uuid4;
  readonly received_at: UtcMillis;
  readonly completed_at: UtcMillis;
  readonly handler_elapsed_ns: DecimalString;
}
