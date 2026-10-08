// The execution's safety assessment (design §8.17; BR-RUA-046, AC-RUA-049): the supervisor's two
// duration checks and the cost check, each citing the frozen manifest; any breach makes the
// assessment `breached` with one reason per breached check, and the record is schema-valid.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSafetyAssessment } from '../../../src/execution-lifecycle/safety-assessment.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import type { JsonValue, MoneyDecimal, UtcMillis } from '../../../src/record-contract/primitives.ts';
import { offlineExecution } from '../../support/offline-cloud/offline-execution.ts';
import { ScriptedExecutionSafety } from '../../integration/execution-lifecycle/fakes/scripted-execution-safety.ts';
import { admittedOf, lifecycleValidator } from '../../integration/execution-lifecycle/support/execution-fixtures.ts';

const AT = '2026-10-05T13:00:00.000Z' as UtcMillis;

describe('buildSafetyAssessment', () => {
  it('is within limits when every check is, and cites the frozen manifest on each', () => {
    const admitted = admittedOf(offlineExecution('run'));
    const assessment = buildSafetyAssessment(admitted, new ScriptedExecutionSafety().checks(), AT);
    assert.equal(assessment.safety_status, 'within_limits');
    assert.deepEqual(
      assessment.checks.map((check) => check.boundary),
      ['ACTIVE_TIME', 'TOTAL_TIME', 'ESTIMATED_COST'],
    );
    for (const check of assessment.checks) {
      assert.deepEqual(check.evidence_refs, [
        { artifact_path: EXECUTION_PATHS.executionManifest, artifact_sha256: admitted.manifest_sha256 },
      ]);
    }
    assert.deepEqual(assessment.reasons, []);
    assert.equal(assessment.assessed_at, AT);
    assert.equal(lifecycleValidator().validate(assessment as unknown as JsonValue).valid, true);
  });

  it('is breached with a TOTAL_TIME_BREACHED reason after a cleanup past the total target', () => {
    const safety = new ScriptedExecutionSafety();
    safety.exceedTotal();
    const assessment = buildSafetyAssessment(admittedOf(offlineExecution('run')), safety.checks(), AT);
    assert.equal(assessment.safety_status, 'breached');
    assert.deepEqual(
      assessment.reasons.map((reason) => reason.code),
      ['TOTAL_TIME_BREACHED'],
    );
    assert.match(assessment.reasons[0]?.detail ?? '', /past its declared limit 5400000 ms/);
  });

  it('breaches the cost check when the frozen estimate is above the frozen ceiling', () => {
    const admitted = admittedOf(offlineExecution('run'));
    const pricey = {
      ...admitted,
      manifest: {
        ...admitted.manifest,
        estimates: { ...admitted.manifest.estimates, estimated_cost_usd: '9.99' as MoneyDecimal },
      },
    };
    const assessment = buildSafetyAssessment(pricey, new ScriptedExecutionSafety().checks(), AT);
    const cost = assessment.checks.find((check) => check.boundary === 'ESTIMATED_COST');
    assert.equal(cost?.result, 'breached');
    assert.equal(cost.observed, '9.99 USD');
    assert.deepEqual(
      assessment.reasons.map((reason) => reason.code),
      ['ESTIMATED_COST_BREACHED'],
    );
  });
});
