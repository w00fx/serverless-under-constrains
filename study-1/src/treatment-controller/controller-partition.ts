// Which partition a caller-journal stream record belongs to (design §9.3, D-06, D-10). The
// controller serves one deployment. A run or variant-validation deployment signals in trial
// partitions `<execution_id>#<trial_id>`; a transport-probe deployment signals in its single
// partition `<execution_id>#probe`; every deployment acknowledges the runner's readiness canary
// in `<execution_id>#canary`. A record of any other partition (another execution, a malformed
// key) cannot be attributed to this deployment, so the controller writes nothing for it.

import { executionIdOf } from '../event-journal/journal-scope.ts';
import { isUuid4 } from '../record-contract/identifiers.ts';
import type { ExecutionIdentity, JsonValue, Uuid4 } from '../record-contract/primitives.ts';

export type ControllerPartition =
  | { readonly kind: 'trial'; readonly key: string; readonly trial_id: Uuid4 }
  | { readonly kind: 'probe'; readonly key: string }
  | { readonly kind: 'canary'; readonly key: string };

/** A partition that holds a provider configuration and possibly a treatment item. */
export type ExperimentPartition = Exclude<ControllerPartition, { readonly kind: 'canary' }>;

const CANARY_SUFFIX = 'canary';
const PROBE_SUFFIX = 'probe';

/**
 * The partition a stream record's `pk` names for this deployment, or undefined when the key
 * belongs to another execution or to no partition this deployment serves.
 *
 * @example
 * resolveControllerPartition({ execution_kind: 'RUN', run_id }, `${run_id}#${trial_id}`);
 * // { kind: 'trial', key: `${run_id}#${trial_id}`, trial_id }
 */
export function resolveControllerPartition(
  deployment: ExecutionIdentity,
  pk: JsonValue | undefined,
): ControllerPartition | undefined {
  const prefix = `${executionIdOf(deployment)}#`;
  if (typeof pk !== 'string' || !pk.startsWith(prefix)) {
    return undefined;
  }
  const suffix = pk.slice(prefix.length);
  if (suffix === CANARY_SUFFIX) {
    return { kind: 'canary', key: pk };
  }
  if (deployment.execution_kind === 'TRANSPORT_PROBE') {
    return suffix === PROBE_SUFFIX ? { kind: 'probe', key: pk } : undefined;
  }
  return isUuid4(suffix) ? { kind: 'trial', key: pk, trial_id: suffix } : undefined;
}
