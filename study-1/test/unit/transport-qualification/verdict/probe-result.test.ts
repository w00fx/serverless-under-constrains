// The probe verdict's exact BR-RUA-027 precedence and the frozen probe result (CTR-RUA-003,
// design §8.11).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonValue, UtcMillis } from '../../../../src/record-contract/primitives.ts';
import type {
  ConditionResult,
  SixConditionResults,
} from '../../../../src/record-contract/records/group-c/shared-shapes.ts';
import { evaluateTreatmentConditions } from '../../../../src/treatment-fidelity/treatment-conditions.ts';
import { buildProbeResult } from '../../../../src/transport-qualification/verdict/probe-result.ts';
import { deriveProbeVerdict } from '../../../../src/transport-qualification/verdict/probe-verdict.ts';
import { GOLDEN_VALIDATOR } from '../../../golden/transport-qualification/verdict/support/probe-golden.ts';
import { assertWellFormed } from '../../../golden/transport-qualification/verdict/support/verdict-assertions.ts';
import {
  deleteOp,
  EXTRA_CALL_PLAN,
  probeEvidence,
  treatmentView,
  trialEvidence,
} from '../../treatment-fidelity/support/treatment-evidence.ts';
import { PROBE_EDITS } from '../../treatment-fidelity/support/treatment-scenarios.ts';
import { codes } from '../../treatment-fidelity/support/view-edits.ts';

const CHECKED_AT = '2026-10-05T12:08:00.000Z' as UtcMillis;

function passing(): SixConditionResults {
  return evaluateTreatmentConditions(treatmentView(probeEvidence()));
}

function withFirst(
  result: ConditionResult['result'],
  affectedBy: ConditionResult['affected_by'] = [],
): readonly ConditionResult[] {
  const [first, ...rest] = passing();
  return [{ ...first, result, affected_by: affectedBy }, ...rest];
}

function resultOf(...edits: Parameters<typeof probeEvidence>): ReturnType<typeof buildProbeResult> {
  return buildProbeResult({ evidence: probeEvidence(...edits), checked_at: CHECKED_AT });
}

describe('deriveProbeVerdict', () => {
  it('passes when the probe is valid, every condition passes and evidence is verified', () => {
    assert.equal(deriveProbeVerdict('valid', passing(), 'verified'), 'pass');
  });

  it('is indeterminate for an invalid probe, even when a condition fails', () => {
    assert.equal(deriveProbeVerdict('invalid', passing(), 'verified'), 'indeterminate');
    assert.equal(deriveProbeVerdict('invalid', withFirst('fail'), 'verified'), 'indeterminate');
  });

  it('fails on an unaffected failed condition, whatever the evidence integrity', () => {
    assert.equal(deriveProbeVerdict('valid', withFirst('fail'), 'unverified'), 'fail');
    assert.equal(deriveProbeVerdict('indeterminate', withFirst('fail'), 'invalid'), 'fail');
  });

  it('is indeterminate for a failure on affected evidence', () => {
    assert.equal(deriveProbeVerdict('valid', withFirst('fail', ['SOURCE_SEQUENCE_GAP']), 'verified'), 'indeterminate');
  });

  it('is indeterminate for an indeterminate condition or unverified evidence', () => {
    assert.equal(deriveProbeVerdict('valid', withFirst('indeterminate'), 'verified'), 'indeterminate');
    assert.equal(deriveProbeVerdict('valid', passing(), 'unverified'), 'indeterminate');
    assert.equal(deriveProbeVerdict('indeterminate', passing(), 'verified'), 'pass');
  });
});

describe('buildProbeResult', () => {
  it('builds the passing, schema-valid result of the base probe', () => {
    const result = resultOf();
    assert.equal(result.ok, true);
    assertWellFormed(result.value);
    assert.equal(result.value.transport_probe_id, '2559d5f6-ec95-4777-a74e-452fcfde7526');
    assert.equal(result.value.transport_probe_verdict, 'pass');
    assert.equal(result.value.ordering_basis, 'cross_source_wall_clock');
    assert.equal(result.value.checked_at, CHECKED_AT);
    assert.deepEqual(result.value.indeterminate_reasons, []);
    assert.equal(result.value.condition_results.length, 6);
  });

  it('records a failing result with its cardinality and no evidence member', () => {
    const result = resultOf(PROBE_EDITS.elapsed_short);
    assert.equal(result.ok && result.value.transport_probe_verdict, 'fail');
    if (result.ok) {
      assertWellFormed(result.value);
    }
  });

  // Review regression (WP-10): BR-RUA-027 makes the probe invalid only for an additional
  // transaction; a row read twice is not one, so an unaffected failure still fails the transport.
  it('fails on an unaffected failed condition over a ledger that repeats a transaction row', () => {
    const result = resultOf([...PROBE_EDITS.ledger_duplicate, ...PROBE_EDITS.elapsed_short]);
    assert.equal(result.ok, true);
    assertWellFormed(result.value);
    assert.equal(result.value.probe_validity, 'indeterminate');
    assert.equal(result.value.probe_cardinality.committed_transactions, 1);
    assert.equal(result.value.transport_probe_verdict, 'fail');
  });

  it('records an invalid probe as indeterminate, with the validity reasons', () => {
    const result = resultOf([], EXTRA_CALL_PLAN);
    assert.equal(result.ok, true);
    assertWellFormed(result.value);
    assert.equal(result.value.transport_probe_verdict, 'indeterminate');
    assert.equal(result.value.probe_validity, 'invalid');
    assert.ok(codes(result.value.indeterminate_reasons).includes('PROBE_CARDINALITY_EXCEEDED'));
  });

  it('records unverified evidence and indeterminate conditions among the reasons', () => {
    const settlement = resultOf(PROBE_EDITS.settlement_not_established);
    assert.ok(settlement.ok && codes(settlement.value.indeterminate_reasons).includes('SETTLEMENT_NOT_ESTABLISHED'));
    const missing = resultOf(PROBE_EDITS.no_confirmation);
    assert.ok(missing.ok);
    assertWellFormed(missing.value);
    assert.deepEqual(codes(missing.value.indeterminate_reasons), ['EVENT_MISSING']);
  });

  it('is schema-valid for every named probe edit', () => {
    for (const [name, operations] of Object.entries(PROBE_EDITS)) {
      const result = resultOf(operations);
      assert.equal(result.ok, true, name);
      const validation = GOLDEN_VALIDATOR.validateAs('transport_probe_result', result.value as unknown as JsonValue);
      assert.equal(validation.valid, true, `${name}: ${JSON.stringify(validation.valid ? [] : validation.violations)}`);
    }
  });

  it('refuses evidence of another execution kind with PROBE_EXECUTION_UNKNOWN', () => {
    const result = buildProbeResult({ evidence: trialEvidence('run-conventional-treatment'), checked_at: CHECKED_AT });
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result.error), ['PROBE_EXECUTION_UNKNOWN']);
    assert.match(result.error[0]?.detail ?? '', /execution kind RUN/u);
  });

  it('refuses evidence without an execution manifest', () => {
    const result = resultOf([deleteOp('admission/execution-manifest.json')]);
    assert.equal(result.ok, false);
    assert.match(result.error[0]?.detail ?? '', /execution kind \(none\)/u);
  });

  it('refuses probe evidence without a manifest digest', () => {
    const evidence = probeEvidence();
    const { execution_manifest_sha256: _digest, ...scope } = evidence.scope;
    const result = buildProbeResult({ evidence: { ...evidence, scope }, checked_at: CHECKED_AT });
    assert.deepEqual(result.ok ? [] : codes(result.error), ['PROBE_EXECUTION_UNKNOWN']);
  });

  it('passes on the treatment view refusal', () => {
    const evidence = probeEvidence();
    const { trial: _trial, ...scope } = evidence.scope;
    const result = buildProbeResult({
      evidence: { ...evidence, scope: { ...scope, subject_kind: 'trial' } },
      checked_at: CHECKED_AT,
    });
    assert.deepEqual(result.ok ? [] : codes(result.error), ['TREATMENT_NOT_APPLICABLE']);
  });
});
