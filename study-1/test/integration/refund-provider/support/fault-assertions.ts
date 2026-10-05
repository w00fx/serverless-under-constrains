// Asserts that a provider operation ends with one specific ProviderFault.

import assert from 'node:assert/strict';

import type { FaultPhase, ProviderFaultCode } from '../../../../src/refund-provider/provider-fault.ts';
import { ProviderFault } from '../../../../src/refund-provider/provider-fault.ts';

/** Awaits `pending` and returns its ProviderFault; fails unless it has this code and phase. */
export async function expectProviderFault(
  pending: Promise<unknown>,
  code: ProviderFaultCode,
  phase: FaultPhase,
): Promise<ProviderFault> {
  try {
    await pending;
  } catch (error) {
    assert.ok(error instanceof ProviderFault, `threw ${String(error)}; expected a ProviderFault ${code}`);
    assert.equal(error.code, code, error.message);
    assert.equal(error.phase, phase, error.message);
    return error;
  }
  assert.fail(`resolved; expected a ProviderFault ${code} (${phase})`);
}
