// Where a provider call belongs (design §9.3). A transport-probe deployment has one fixed
// partition, `<execution_id>#probe`. A run or variant-validation deployment serves one trial
// at a time; the provider cannot read the trial registry (IAM matrix §9.6), so the call's own
// `trial_id` names the partition, and the frozen configuration found there decides whether
// the call is accepted. Every provider event of the call is journaled in that partition with
// the configuration's manifest digest. A call that names no configured trial is journaled in
// `<execution_id>#provider` instead (Owner amendment A-09).

import type { JournalScope } from '../event-journal/journal-scope.ts';
import { executionIdOf } from '../event-journal/journal-scope.ts';
import { isUuid4 } from '../record-contract/identifiers.ts';
import { isJsonObject } from '../record-contract/json-value.ts';
import type { ExecutionIdentity, JsonValue, Sha256Hex, Uuid4 } from '../record-contract/primitives.ts';
import type { ProviderConfigView } from './control-items.ts';

export interface CallPartition {
  /** The table partition key: `<execution_id>#<trial_id>` or `<execution_id>#probe`. */
  readonly key: string;
  /** The trial the partition belongs to; absent for the transport probe (D-06). */
  readonly trial_id?: Uuid4;
}

/**
 * The partition a received call addresses, or undefined when a trial deployment receives a
 * call without a well-formed `trial_id` (nothing can attribute it to a configured trial).
 *
 * @example
 * resolveCallPartition({ execution_kind: 'RUN', run_id }, { trial_id, ... }); // { key: `${run_id}#${trial_id}`, trial_id }
 */
export function resolveCallPartition(deployment: ExecutionIdentity, raw: JsonValue): CallPartition | undefined {
  const executionId = executionIdOf(deployment);
  if (deployment.execution_kind === 'TRANSPORT_PROBE') {
    return { key: `${executionId}#probe` };
  }
  const trialId = isJsonObject(raw) ? raw['trial_id'] : undefined;
  return isUuid4(trialId) ? { key: `${executionId}#${trialId}`, trial_id: trialId } : undefined;
}

/**
 * The journal scope of the provider events of one call: the deployment execution, the frozen
 * manifest digest and the trial named by the partition's configuration.
 *
 * @example
 * const journal = openJournal(callJournalScope(deployment, config));
 */
export function callJournalScope(deployment: ExecutionIdentity, config: ProviderConfigView): JournalScope {
  const partition =
    config.trial === undefined ? ({ kind: 'probe' } as const) : { kind: 'trial' as const, ...config.trial };
  return { execution: deployment, execution_manifest_sha256: config.execution_manifest_sha256, partition };
}

/**
 * The journal scope of a warm-up: the execution-level partition `<execution_id>#warmup`
 * (addendum §2), outside every trial.
 *
 * @example
 * const journal = openJournal(warmupJournalScope(deployment, request.execution_manifest_sha256));
 */
export function warmupJournalScope(deployment: ExecutionIdentity, manifestSha256: Sha256Hex): JournalScope {
  return { execution: deployment, execution_manifest_sha256: manifestSha256, partition: { kind: 'warmup' } };
}

/**
 * The journal scope of a call the provider cannot attribute to a trial partition: the
 * execution-level partition `<execution_id>#provider`, under the execution configuration's
 * frozen manifest digest (Owner amendment A-09, human decision).
 *
 * @example
 * const journal = openJournal(unattributedJournalScope(deployment, executionConfig.execution_manifest_sha256));
 */
export function unattributedJournalScope(deployment: ExecutionIdentity, manifestSha256: Sha256Hex): JournalScope {
  return { execution: deployment, execution_manifest_sha256: manifestSha256, partition: { kind: 'provider' } };
}
