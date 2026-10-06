// Safety status derivation (BR-RUA-046): `breached > unverified > within_limits`. One breached
// check makes the execution breached; otherwise one unverified check makes it unverified.

import type { SafetyResult } from '../record-contract/records/group-b/vocabulary.ts';

/**
 * Derives the safety status of a set of checks by precedence. A set with no check has nothing
 * that establishes the limits held, so it is `unverified`.
 *
 * @example
 * deriveSafetyStatus([{ result: 'within_limits' }, { result: 'unverified' }]); // 'unverified'
 * deriveSafetyStatus([{ result: 'unverified' }, { result: 'breached' }]); // 'breached'
 */
export function deriveSafetyStatus(checks: readonly { readonly result: SafetyResult }[]): SafetyResult {
  if (checks.some((check) => check.result === 'breached')) {
    return 'breached';
  }
  if (checks.length === 0 || checks.some((check) => check.result === 'unverified')) {
    return 'unverified';
  }
  return 'within_limits';
}
