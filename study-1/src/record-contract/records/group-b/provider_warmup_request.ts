// Addendum §2 (D-27 resolution): the runner -> provider warm-up payload, sent once before a
// trial publication (or the probe caller invocation) after the controller canary.

import type { Uuid4 } from '../../primitives.ts';
import type { ExecutionCorrelation } from './shared-shapes.ts';

interface ProviderWarmupRequestFields {
  readonly schema_version: 1;
  readonly record_type: 'provider_warmup_request';
  readonly warmup_id: Uuid4;
  /** The trial about to start, as a correlation field only; never a trial partition key. */
  readonly trial_id?: Uuid4;
  readonly trial_manifest_sha256?: never;
}

/** Schema: `schemas/group-b/provider_warmup_request.schema.json`. */
export type ProviderWarmupRequest = ExecutionCorrelation & ProviderWarmupRequestFields;
