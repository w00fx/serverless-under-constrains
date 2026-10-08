// Field groups that several group-B records repeat. The JSON Schemas restate them per file
// (a record schema may reference only `_defs.schema.json`), so these types are the one place
// TypeScript names each group.

import type { ExecutionIdentityFields } from '../../envelope.ts';
import type { Sha256Hex, Uuid4 } from '../../primitives.ts';

/** The caller-generated identities that correlate one physical attempt (INV-RUA-001). */
export interface AttemptCorrelation {
  readonly attempt_id: Uuid4;
  readonly provider_request_id: Uuid4;
  /** Business identity, non-empty after trimming (BR-RUA-003). */
  readonly refund_request_id: string;
}

/** The provider-generated identities one commit plan shares (BR-RUA-025, D-23). */
export interface CommitTriple {
  readonly provider_commit_id: Uuid4;
  readonly provider_transaction_id: Uuid4;
  readonly provider_call_id: Uuid4;
}

/** Approximate SQS counters of one queue read (BR-RUA-032). */
export interface QueueCounters {
  readonly visible: number;
  readonly in_flight: number;
  readonly delayed: number;
}

/** A record that belongs to one trial partition. */
export interface TrialScoped {
  readonly trial_id: Uuid4;
  readonly trial_manifest_sha256: Sha256Hex;
}

/** A record of the execution-level scope: it never carries a trial identity. */
export interface ExecutionScoped {
  readonly trial_id?: never;
  readonly trial_manifest_sha256?: never;
}

/** The identity part of a record without the event envelope: one execution id plus the manifest digest. */
export type ExecutionCorrelation = ExecutionIdentityFields & { readonly execution_manifest_sha256: Sha256Hex };
