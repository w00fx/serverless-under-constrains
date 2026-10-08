// Probe usability (BR-RUA-026, AC-RUA-056, design §8.11): usable only when every row holds; each
// unmet row adds its reason, in table order.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EvidenceRef } from '../../../../src/record-contract/evidence-refs.ts';
import type { JsonValue, Sha256Hex, UtcMillis, Uuid4 } from '../../../../src/record-contract/primitives.ts';
import { assessProbeUsability } from '../../../../src/transport-qualification/verdict/probe-usability.ts';
import type { ProbeUsabilityInput } from '../../../../src/transport-qualification/verdict/probe-usability.ts';
import { GOLDEN_VALIDATOR } from '../../../golden/transport-qualification/verdict/support/probe-golden.ts';

const INDEX = 'a'.repeat(64) as Sha256Hex;
const SUMMARY_REF: EvidenceRef = {
  artifact_path: 'summary/transport-probe-summary.json',
  artifact_sha256: 'b'.repeat(64) as Sha256Hex,
  package_index_sha256: INDEX,
};
const RESULT_REF: EvidenceRef = {
  artifact_path: 'probe/transport-probe-result.json',
  artifact_sha256: 'c'.repeat(64) as Sha256Hex,
  package_index_sha256: INDEX,
};

/** Every BR-RUA-026 row holds. */
const USABLE: ProbeUsabilityInput = {
  transport_probe_id: '2559d5f6-ec95-4777-a74e-452fcfde7526' as Uuid4,
  original_package_index_sha256: INDEX,
  selected_amendment_head_sha256: null,
  probe: {
    transport_probe_verdict: 'pass',
    probe_validity: 'valid',
    treatment_fidelity: 'verified',
    evidence_integrity: 'verified',
  },
  late_evidence_status: 'none',
  closure: {
    effective_cleanup_status: 'succeeded',
    effective_leak_audit_status: 'clean',
    effective_lease_status: 'released',
  },
  safety_status: 'within_limits',
  package_eligibility: 'eligible',
  transport_scope_snapshot_sha256: 'd'.repeat(64) as Sha256Hex,
  evidence_refs: [SUMMARY_REF, RESULT_REF, SUMMARY_REF],
  assessed_at: '2026-10-05T12:40:00.000Z' as UtcMillis,
};

function reasonCodes(input: ProbeUsabilityInput): readonly string[] {
  const assessment = assessProbeUsability(input);
  const validation = GOLDEN_VALIDATOR.validateAs('probe_usability_assessment', assessment as unknown as JsonValue);
  assert.equal(validation.valid, true, JSON.stringify(validation.valid ? [] : validation.violations));
  return assessment.reasons.map((reason) => reason.code);
}

describe('assessProbeUsability', () => {
  it('is usable when every row holds, recording the facts and canonical references', () => {
    const assessment = assessProbeUsability(USABLE);
    assert.equal(assessment.probe_usability, 'usable');
    assert.deepEqual(assessment.reasons, []);
    assert.deepEqual(assessment.evidence_refs, [RESULT_REF, SUMMARY_REF]);
    assert.equal(assessment.transport_scope_snapshot_sha256, USABLE.transport_scope_snapshot_sha256);
    assert.equal(assessment.effective_cleanup_status, 'succeeded');
    assert.equal(assessment.package_eligibility, 'eligible');
    assert.deepEqual(reasonCodes(USABLE), []);
  });

  it('is usable with consistent late evidence and an unverified (not breached) safety status', () => {
    assert.deepEqual(reasonCodes({ ...USABLE, late_evidence_status: 'consistent', safety_status: 'unverified' }), []);
  });

  it('names PROBE_NOT_PASSING for a verdict other than pass', () => {
    const probe = { ...USABLE.probe, transport_probe_verdict: 'indeterminate' as const };
    assert.deepEqual(reasonCodes({ ...USABLE, probe }), ['PROBE_NOT_PASSING']);
  });

  it('names PROBE_INVALID_OR_UNFAITHFUL for an invalid probe or unverified fidelity', () => {
    assert.deepEqual(reasonCodes({ ...USABLE, probe: { ...USABLE.probe, probe_validity: 'indeterminate' } }), [
      'PROBE_INVALID_OR_UNFAITHFUL',
    ]);
    assert.deepEqual(reasonCodes({ ...USABLE, probe: { ...USABLE.probe, treatment_fidelity: 'unverified' } }), [
      'PROBE_INVALID_OR_UNFAITHFUL',
    ]);
  });

  it('names EVIDENCE_NOT_VERIFIED', () => {
    assert.deepEqual(reasonCodes({ ...USABLE, probe: { ...USABLE.probe, evidence_integrity: 'unverified' } }), [
      'EVIDENCE_NOT_VERIFIED',
    ]);
  });

  it('names LATE_EVIDENCE_CONTRADICTORY and LATE_EVIDENCE_UNVERIFIED', () => {
    assert.deepEqual(reasonCodes({ ...USABLE, late_evidence_status: 'contradictory' }), [
      'LATE_EVIDENCE_CONTRADICTORY',
    ]);
    assert.deepEqual(reasonCodes({ ...USABLE, late_evidence_status: 'unverified' }), ['LATE_EVIDENCE_UNVERIFIED']);
  });

  it('names OPERATIONAL_CLOSURE_NOT_CLEAN for each unclean closure member', () => {
    const closures = [
      { ...USABLE.closure, effective_cleanup_status: 'partial' as const },
      { ...USABLE.closure, effective_leak_audit_status: 'leaks_detected' as const },
      { ...USABLE.closure, effective_lease_status: 'recovery_required' as const },
    ];
    for (const closure of closures) {
      assert.deepEqual(reasonCodes({ ...USABLE, closure }), ['OPERATIONAL_CLOSURE_NOT_CLEAN']);
    }
  });

  it('names KNOWN_SAFETY_BREACH, PACKAGE_NOT_VERIFIED and NO_TRANSPORT_SCOPE_SNAPSHOT', () => {
    assert.deepEqual(reasonCodes({ ...USABLE, safety_status: 'breached' }), ['KNOWN_SAFETY_BREACH']);
    assert.deepEqual(reasonCodes({ ...USABLE, package_eligibility: 'ineligible' }), ['PACKAGE_NOT_VERIFIED']);
    const { transport_scope_snapshot_sha256: _snapshot, ...withoutSnapshot } = USABLE;
    const assessment = assessProbeUsability(withoutSnapshot);
    assert.equal(Object.hasOwn(assessment, 'transport_scope_snapshot_sha256'), false);
    assert.deepEqual(reasonCodes(withoutSnapshot), ['NO_TRANSPORT_SCOPE_SNAPSHOT']);
  });

  it('lists every unmet row in table order', () => {
    const { transport_scope_snapshot_sha256: _snapshot, ...nothingHolds } = {
      ...USABLE,
      probe: {
        transport_probe_verdict: 'fail' as const,
        probe_validity: 'invalid' as const,
        treatment_fidelity: 'invalid' as const,
        evidence_integrity: 'invalid' as const,
      },
      late_evidence_status: 'contradictory' as const,
      closure: {
        effective_cleanup_status: 'failed' as const,
        effective_leak_audit_status: 'unverified' as const,
        effective_lease_status: 'unverified' as const,
      },
      safety_status: 'breached' as const,
      package_eligibility: 'ineligible' as const,
    };
    const assessment = assessProbeUsability(nothingHolds);
    assert.equal(assessment.probe_usability, 'not_usable');
    assert.deepEqual(
      assessment.reasons.map((reason) => reason.code),
      [
        'PROBE_NOT_PASSING',
        'PROBE_INVALID_OR_UNFAITHFUL',
        'EVIDENCE_NOT_VERIFIED',
        'LATE_EVIDENCE_CONTRADICTORY',
        'OPERATIONAL_CLOSURE_NOT_CLEAN',
        'KNOWN_SAFETY_BREACH',
        'PACKAGE_NOT_VERIFIED',
        'NO_TRANSPORT_SCOPE_SNAPSHOT',
      ],
    );
    assert.ok(assessment.reasons.every((reason) => reason.subject === 'BR-RUA-026'));
  });
});
