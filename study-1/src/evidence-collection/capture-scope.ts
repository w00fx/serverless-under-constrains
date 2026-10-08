// What one collection reads and how its records correlate (design §5.3 `evidence-collection/`,
// §9.3). A capture belongs to one execution and either one trial partition
// (`<execution_id>#<trial_id>`) or the probe partition (`<execution_id>#probe`, D-06: the probe has
// no trial id). Every collected record carries the execution identity and manifest digest, and the
// trial identity exactly when the unit is a trial (BR-RUA-008, BR-RUA-033).

import { journalPartitionKey } from '../event-journal/journal-scope.ts';
import type { JournalPartition } from '../event-journal/journal-scope.ts';
import { executionIdentityFields } from '../record-contract/envelope.ts';
import type { ExecutionIdentity, JsonObject, Sha256Hex, Uuid4 } from '../record-contract/primitives.ts';

/** The trial or probe whose partition a capture reads. */
export type CaptureUnit =
  | { readonly kind: 'trial'; readonly trial_id: Uuid4; readonly trial_manifest_sha256: Sha256Hex }
  | { readonly kind: 'probe' };

/** One execution plus the trial or probe being collected. */
export interface CaptureScope {
  readonly execution: ExecutionIdentity;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly unit: CaptureUnit;
}

/** A capture scope whose unit is a trial: queue, DLQ and Durable evidence exist only for trials. */
export type TrialCaptureScope = CaptureScope & { readonly unit: Extract<CaptureUnit, { readonly kind: 'trial' }> };

/** The execution-level partitions that hold readiness and unattributed-call evidence (D-10, addendum §2, A-09). */
export type ExecutionPartitionKind = 'canary' | 'warmup' | 'provider';

/**
 * The table partition key of the capture's unit (design §9.3).
 *
 * @example
 * capturePartitionKey({ execution: { execution_kind: 'RUN', run_id }, execution_manifest_sha256, unit: { kind: 'probe' } });
 * // `${run_id}#probe`
 */
export function capturePartitionKey(scope: CaptureScope): string {
  const partition: JournalPartition = scope.unit.kind === 'trial' ? { ...scope.unit } : { kind: 'probe' };
  return journalPartitionKey({
    execution: scope.execution,
    execution_manifest_sha256: scope.execution_manifest_sha256,
    partition,
  });
}

/**
 * The partition key of an execution-level partition (design §9.3; A-09 `<execution_id>#provider`).
 *
 * @example
 * executionPartitionKey(execution, digest, 'warmup'); // `${run_id}#warmup`
 */
export function executionPartitionKey(
  execution: ExecutionIdentity,
  executionManifestSha256: Sha256Hex,
  kind: ExecutionPartitionKind,
): string {
  return journalPartitionKey({ execution, execution_manifest_sha256: executionManifestSha256, partition: { kind } });
}

/**
 * The correlation members every record of the capture carries: the execution identity field, the
 * manifest digest and, for a trial, the trial id and trial-manifest digest.
 *
 * @example
 * correlationFields(scope); // { run_id, execution_manifest_sha256, trial_id, trial_manifest_sha256 }
 */
export function correlationFields(scope: CaptureScope): JsonObject {
  const execution = {
    ...executionIdentityFields(scope.execution),
    execution_manifest_sha256: scope.execution_manifest_sha256,
  };
  if (scope.unit.kind === 'probe') {
    return execution;
  }
  return { ...execution, trial_id: scope.unit.trial_id, trial_manifest_sha256: scope.unit.trial_manifest_sha256 };
}

/**
 * Whether the capture's unit is a trial, narrowing the scope for trial-only evidence.
 *
 * @example
 * if (isTrialScope(scope)) observeQueue(reader, target, scope, clock);
 */
export function isTrialScope(scope: CaptureScope): scope is TrialCaptureScope {
  return scope.unit.kind === 'trial';
}
