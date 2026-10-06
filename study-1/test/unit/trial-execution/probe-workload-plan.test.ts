// The probe workload plan (BR-RUA-027, OR-RUA-001, OR-RUA-002): derived from the frozen probe
// manifest and the stack's published versions only; a manifest of another execution kind or a
// target that is not a published version number plans nothing.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ExecutionManifest } from '../../../src/record-contract/records/group-a/execution_manifest.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { declaredFinancialRecords, planProbeWorkload } from '../../../src/trial-execution/probe-workload-plan.ts';
import { executionManifest } from '../../support/golden-builder/execution-files.ts';
import { MANIFEST_SHA } from './support/trial-execution-fixtures.ts';

const PROBE_MANIFEST = executionManifest('probe') as unknown as ExecutionManifest & {
  readonly execution_kind: 'TRANSPORT_PROBE';
};
const TARGETS = { provider_version: '3', probe_caller_version: '1' };
const validator = createRecordValidator();

describe('declaredFinancialRecords', () => {
  it('builds the payment and approved decision the manifest declares', () => {
    const inputs = PROBE_MANIFEST.financial_inputs;
    const records = declaredFinancialRecords(PROBE_MANIFEST);
    assert.deepEqual(records.payment, {
      schema_version: 1,
      record_type: 'payment',
      payment_id: inputs.payment_id,
      captured_amount_minor: inputs.captured_amount_minor,
      currency: inputs.currency,
    });
    assert.deepEqual(records.approved_decision, {
      schema_version: 1,
      record_type: 'approved_decision',
      refund_request_id: inputs.refund_request_id,
      payment_id: inputs.payment_id,
      decision: inputs.decision,
      approved_amount_minor: inputs.approved_amount_minor,
      currency: inputs.currency,
    });
    assert.equal(validator.validate(records.payment as unknown as JsonValue).valid, true);
    assert.equal(validator.validate(records.approved_decision as unknown as JsonValue).valid, true);
  });
});

describe('planProbeWorkload', () => {
  it('plans the probe from its manifest and the published versions', () => {
    const planned = planProbeWorkload(PROBE_MANIFEST, MANIFEST_SHA, TARGETS);
    assert.ok(planned.ok);
    const plan = planned.value;
    const inputs = PROBE_MANIFEST.financial_inputs;
    assert.deepEqual(plan.execution, {
      execution_kind: 'TRANSPORT_PROBE',
      transport_probe_id: PROBE_MANIFEST.transport_probe_id,
    });
    assert.equal(plan.execution_manifest_sha256, MANIFEST_SHA);
    assert.deepEqual(
      { payment: plan.payment, approved_decision: plan.approved_decision },
      declaredFinancialRecords(PROBE_MANIFEST),
    );
    assert.deepEqual(plan.provider_timing, {
      safety_release_ms: PROBE_MANIFEST.timing.provider_safety_release_ms,
      treatment_poll_interval_ms: PROBE_MANIFEST.timing.treatment_poll_interval_ms,
    });
    assert.equal(plan.provider_version, '3');
    assert.equal(plan.probe_caller_version, '1');
    assert.deepEqual(plan.request, {
      schema_version: 1,
      record_type: 'probe_workload_request',
      transport_probe_id: PROBE_MANIFEST.transport_probe_id,
      execution_manifest_sha256: MANIFEST_SHA,
      payment_id: inputs.payment_id,
      refund_request_id: inputs.refund_request_id,
      amount_minor: inputs.approved_amount_minor,
      currency: 'BRL',
    });
    assert.equal(validator.validate(plan.request as unknown as JsonValue).valid, true);
    assert.equal('trial' in plan, false);
  });

  it('refuses the manifest of a run or a variant validation', () => {
    for (const name of ['run', 'validation-conventional'] as const) {
      const planned = planProbeWorkload(executionManifest(name) as unknown as ExecutionManifest, MANIFEST_SHA, TARGETS);
      assert.equal(planned.ok, false, name);
      assert.equal(planned.error.code, 'PROBE_PLAN_INVALID');
      assert.match(planned.error.detail, /declares a (RUN|VARIANT_VALIDATION), not a TRANSPORT_PROBE/);
    }
  });

  it('refuses a target that is not a published version number', () => {
    for (const bad of ['$LATEST', '0', '01', '', 'live', '1.0']) {
      for (const field of ['provider_version', 'probe_caller_version'] as const) {
        const planned = planProbeWorkload(PROBE_MANIFEST, MANIFEST_SHA, { ...TARGETS, [field]: bad });
        assert.equal(planned.ok, false, `${field} ${bad}`);
        assert.equal(planned.error.subject, 'BR-RUA-027');
        assert.match(planned.error.detail, new RegExp(`^${field} ".*" is not a published version number`));
      }
    }
  });
});
