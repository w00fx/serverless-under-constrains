// Catalogue group B row 50 (design §6.2): the single synchronous Invoke of the probe caller
// returned (BR-RUA-027).

import type { EventEnvelope } from '../../envelope.ts';

/** Schema: `schemas/group-b/probe_workload_invoked.schema.json`. */
export interface ProbeWorkloadInvoked extends EventEnvelope<'probe_workload_invoked'> {
  readonly source: 'runner';
  readonly trial_id?: never;
  readonly trial_manifest_sha256?: never;
  readonly lambda_request_id: string;
  /** HTTP status of the Invoke response. */
  readonly status_code: number;
  readonly executed_version?: string;
  readonly function_error?: string;
}
