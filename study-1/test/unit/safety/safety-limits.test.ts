// OR-RUA-003, -004, -005 safety limits and the manifest's declared safety (BR-RUA-046, -040).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PROBE_SAFETY,
  RUN_SAFETY,
  SAFETY_REGION,
  VALIDATION_SAFETY,
  declaredSafetyOf,
  safetyLimitsFor,
} from '../../../src/safety/safety-limits.ts';

describe('safety limits', () => {
  it('declare the OR-RUA-003 canonical run limits', () => {
    assert.deepEqual(RUN_SAFETY, {
      active_ms: 4_500_000,
      cleanup_ms: 900_000,
      total_ms: 5_400_000,
      ceiling_usd: '5.00',
      region: 'us-east-1',
    });
  });

  it('declare the OR-RUA-004 transport probe limits', () => {
    assert.deepEqual(PROBE_SAFETY, {
      active_ms: 600_000,
      cleanup_ms: 600_000,
      total_ms: 1_200_000,
      ceiling_usd: '1.00',
      region: 'us-east-1',
    });
  });

  it('declare the OR-RUA-005 variant validation limits as the run limits', () => {
    assert.deepEqual(VALIDATION_SAFETY, RUN_SAFETY);
    assert.equal(SAFETY_REGION, 'us-east-1');
  });

  it('select the limits of each execution kind', () => {
    assert.equal(safetyLimitsFor('RUN'), RUN_SAFETY);
    assert.equal(safetyLimitsFor('TRANSPORT_PROBE'), PROBE_SAFETY);
    assert.equal(safetyLimitsFor('VARIANT_VALIDATION'), VALIDATION_SAFETY);
  });

  it('declare one concurrent owner with the limits in the manifest', () => {
    assert.deepEqual(declaredSafetyOf(PROBE_SAFETY), {
      region: 'us-east-1',
      active_ms: 600_000,
      cleanup_ms: 600_000,
      total_ms: 1_200_000,
      ceiling_usd: '1.00',
      concurrent_owners: 1,
    });
  });
});
