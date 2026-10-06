// The declared inputs (OR-RUA-001, OR-RUA-002, addendum §2, CA-1, BR-RUA-007): the exact
// committed values, the one variant difference only a run declares, and the scope timing slice.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CA_1_DECLARATION,
  OR_RUA_001_APPROVED_DECISION,
  OR_RUA_001_PAYMENT,
  OR_RUA_002_TIMING,
  PROVIDER_WARMUP_POLICY,
  declaredVariantDifferences,
  scopeTimingOf,
} from '../../../src/admission/declared-inputs.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';

describe('declared inputs', () => {
  it('OR-RUA-001 records are valid payment and approved decision records', () => {
    const validator = createRecordValidator();
    assert.equal(validator.validateAs('payment', OR_RUA_001_PAYMENT).valid, true);
    assert.equal(validator.validateAs('approved_decision', OR_RUA_001_APPROVED_DECISION).valid, true);
    assert.deepEqual(
      [OR_RUA_001_PAYMENT['captured_amount_minor'], OR_RUA_001_APPROVED_DECISION['approved_amount_minor']],
      [10000, 10000],
    );
  });

  it('OR-RUA-002 timing, the warm-up policy and CA-1 are declared verbatim', () => {
    assert.equal(OR_RUA_002_TIMING.durable_visibility_timeout_ms, 360_000);
    assert.equal(OR_RUA_002_TIMING.retry_jitter, 'NONE');
    assert.deepEqual(PROVIDER_WARMUP_POLICY, { invocations_per_trial: 1 });
    assert.equal(CA_1_DECLARATION.status, 'declared_not_service_guaranteed');
    assert.equal((CA_1_DECLARATION as unknown as Readonly<Record<string, JsonValue>>)['assumption_id'], 'CA-1');
  });

  it('only a run declares the source visibility difference', () => {
    assert.deepEqual(declaredVariantDifferences('RUN'), [
      {
        parameter: 'source_visibility_timeout_ms',
        conventional: 60_000,
        durable: 360_000,
        basis: 'BR-RUA-020: the Durable source stays invisible throughout its longer execution',
      },
    ]);
    assert.deepEqual(declaredVariantDifferences('TRANSPORT_PROBE'), []);
    assert.deepEqual(declaredVariantDifferences('VARIANT_VALIDATION'), []);
  });

  it('the scope binds the four transport timing values', () => {
    assert.deepEqual(scopeTimingOf(OR_RUA_002_TIMING), {
      provider_client_deadline_ms: 3000,
      provider_safety_release_ms: 15000,
      provider_execution_timeout_ms: 30000,
      treatment_poll_interval_ms: 250,
    });
  });
});
