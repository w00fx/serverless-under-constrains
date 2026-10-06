// Whether a record read back from a package belongs to the execution being verified. A record
// carries exactly one of `run_id`, `transport_probe_id` and `variant_validation_id` (D-06); it
// belongs when that one field is the execution's id and the other two are absent.

import { executionIdentityFields } from '../record-contract/envelope.ts';
import type { ExecutionIdentity } from '../record-contract/primitives.ts';

type IdentityKey = 'run_id' | 'transport_probe_id' | 'variant_validation_id';

/** Any record that may carry an execution id. */
export type IdentityCarrier = Readonly<Partial<Record<IdentityKey, string>>>;

const IDENTITY_KEYS: readonly IdentityKey[] = ['run_id', 'transport_probe_id', 'variant_validation_id'];

/**
 * True when `record` names exactly the execution `identity`, and no other execution id.
 *
 * @example
 * belongsToExecution({ run_id }, { execution_kind: 'RUN', run_id }); // true
 */
export function belongsToExecution(record: IdentityCarrier, identity: ExecutionIdentity): boolean {
  const expected: IdentityCarrier = executionIdentityFields(identity);
  return IDENTITY_KEYS.every((key) => record[key] === expected[key]);
}
