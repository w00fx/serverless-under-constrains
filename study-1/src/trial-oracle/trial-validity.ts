// BR-RUA-029 trial validity, exactly as design §8.4 states it: a not-applicable gate is ignored,
// any invalid gate makes the trial invalid, any unverified gate makes it indeterminate, and only
// a trial whose applicable gates are all verified is valid.

import type { GateValue } from '../record-contract/primitives.ts';
import type { TrialValidity } from '../record-contract/records/group-c/vocabulary.ts';

/**
 * The trial validity of its gate values.
 *
 * @example
 * deriveTrialValidity([{ value: 'verified' }, { value: 'not_applicable' }]); // 'valid'
 * deriveTrialValidity([{ value: 'unverified' }, { value: 'invalid' }]); // 'invalid'
 */
export function deriveTrialValidity(gates: readonly { readonly value: GateValue }[]): TrialValidity {
  const applicable = gates.filter((gate) => gate.value !== 'not_applicable');
  if (applicable.some((gate) => gate.value === 'invalid')) {
    return 'invalid';
  }
  if (applicable.some((gate) => gate.value === 'unverified')) {
    return 'indeterminate';
  }
  return 'valid';
}
