// Design §12.5 and §8.11 as properties: the exact BR-RUA-027 verdict precedence over arbitrary
// condition outcomes; the probe result over arbitrary probe edits is a valid
// `transport_probe_result` whose verdict follows from its own parts (CTR-RUA-003); and BR-RUA-026
// usability holds exactly when every row holds, with one reason per unmet row in table order.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { JsonValue, Sha256Hex, UtcMillis, Uuid4 } from '../../../../src/record-contract/primitives.ts';
import { SAFETY_RESULTS } from '../../../../src/record-contract/records/group-b/vocabulary.ts';
import type { ConditionResult } from '../../../../src/record-contract/records/group-c/shared-shapes.ts';
import {
  APPLICABLE_GATE_VALUES,
  EFFECTIVE_CLEANUP_STATUSES,
  EFFECTIVE_LEAK_AUDIT_STATUSES,
  ELIGIBILITIES,
  LATE_EVIDENCE_STATUSES,
  LEASE_STATUSES,
  PRESERVATION_VERDICTS,
  TRIAL_VALIDITIES,
} from '../../../../src/record-contract/records/group-c/vocabulary.ts';
import type { PreservationVerdict, TrialValidity } from '../../../../src/record-contract/records/group-c/vocabulary.ts';
import { evaluateTreatmentConditions } from '../../../../src/treatment-fidelity/treatment-conditions.ts';
import { buildProbeResult } from '../../../../src/transport-qualification/verdict/probe-result.ts';
import { assessProbeUsability } from '../../../../src/transport-qualification/verdict/probe-usability.ts';
import type { ProbeUsabilityInput } from '../../../../src/transport-qualification/verdict/probe-usability.ts';
import { deriveProbeVerdict } from '../../../../src/transport-qualification/verdict/probe-verdict.ts';
import { GOLDEN_VALIDATOR } from '../../../golden/transport-qualification/verdict/support/probe-golden.ts';
import { fuzzParameters } from '../../../support/kernel/fuzz-parameters.ts';
import { probeEvidence, treatmentView } from '../../../unit/treatment-fidelity/support/treatment-evidence.ts';
import { assertWellFormedCondition } from '../../../unit/treatment-fidelity/support/view-edits.ts';
import { editedProbeEvidence, journalEditsArbitrary } from '../../treatment-fidelity/support/journal-edits.ts';

const BASE_CONDITIONS = evaluateTreatmentConditions(treatmentView(probeEvidence()));
const CHECKED_AT = '2026-10-05T12:08:00.000Z' as UtcMillis;

/** The BR-RUA-027 table, row by row, as the spec states it. */
function specVerdict(
  validity: TrialValidity,
  conditions: readonly ConditionResult[],
  integrity: string,
): PreservationVerdict {
  if (validity === 'invalid') {
    return 'indeterminate';
  }
  for (const condition of conditions) {
    if (condition.result === 'fail' && condition.affected_by.length === 0) {
      return 'fail';
    }
  }
  const allPass = conditions.filter((condition) => condition.result === 'pass').length === conditions.length;
  return allPass && integrity === 'verified' ? 'pass' : 'indeterminate';
}

const conditionsArbitrary = fc
  .array(fc.record({ result: fc.constantFrom(...PRESERVATION_VERDICTS), affected: fc.boolean() }), {
    minLength: 6,
    maxLength: 6,
  })
  .map((outcomes) =>
    BASE_CONDITIONS.map((condition, index): ConditionResult => ({
      ...condition,
      result: outcomes[index]?.result ?? 'pass',
      affected_by: outcomes[index]?.affected === true ? ['SOURCE_SEQUENCE_GAP'] : [],
    })),
  );

const usabilityArbitrary: fc.Arbitrary<ProbeUsabilityInput> = fc.record(
  {
    transport_probe_id: fc.constant('2559d5f6-ec95-4777-a74e-452fcfde7526' as Uuid4),
    original_package_index_sha256: fc.constant('a'.repeat(64) as Sha256Hex),
    selected_amendment_head_sha256: fc.constantFrom(null, 'b'.repeat(64) as Sha256Hex),
    probe: fc.record({
      transport_probe_verdict: fc.constantFrom(...PRESERVATION_VERDICTS),
      probe_validity: fc.constantFrom(...TRIAL_VALIDITIES),
      treatment_fidelity: fc.constantFrom(...APPLICABLE_GATE_VALUES),
      evidence_integrity: fc.constantFrom(...APPLICABLE_GATE_VALUES),
    }),
    late_evidence_status: fc.constantFrom(...LATE_EVIDENCE_STATUSES),
    closure: fc.record({
      effective_cleanup_status: fc.constantFrom(...EFFECTIVE_CLEANUP_STATUSES),
      effective_leak_audit_status: fc.constantFrom(...EFFECTIVE_LEAK_AUDIT_STATUSES),
      effective_lease_status: fc.constantFrom(...LEASE_STATUSES),
    }),
    safety_status: fc.constantFrom(...SAFETY_RESULTS),
    package_eligibility: fc.constantFrom(...ELIGIBILITIES),
    transport_scope_snapshot_sha256: fc.constant('c'.repeat(64) as Sha256Hex),
    evidence_refs: fc.constant([]),
    assessed_at: fc.constant('2026-10-05T12:40:00.000Z' as UtcMillis),
  },
  {
    requiredKeys: [
      'transport_probe_id',
      'original_package_index_sha256',
      'selected_amendment_head_sha256',
      'probe',
      'late_evidence_status',
      'closure',
      'safety_status',
      'package_eligibility',
      'evidence_refs',
      'assessed_at',
    ],
  },
);

/** The BR-RUA-026 rows, in table order, as the spec states them. */
function unmetRows(input: ProbeUsabilityInput): readonly string[] {
  const { probe, closure } = input;
  const rows: readonly (readonly [boolean, string])[] = [
    [probe.transport_probe_verdict === 'pass', 'PROBE_NOT_PASSING'],
    [probe.probe_validity === 'valid' && probe.treatment_fidelity === 'verified', 'PROBE_INVALID_OR_UNFAITHFUL'],
    [probe.evidence_integrity === 'verified', 'EVIDENCE_NOT_VERIFIED'],
    [input.late_evidence_status !== 'contradictory', 'LATE_EVIDENCE_CONTRADICTORY'],
    [input.late_evidence_status !== 'unverified', 'LATE_EVIDENCE_UNVERIFIED'],
    [
      closure.effective_cleanup_status === 'succeeded' &&
        closure.effective_leak_audit_status === 'clean' &&
        closure.effective_lease_status === 'released',
      'OPERATIONAL_CLOSURE_NOT_CLEAN',
    ],
    [input.safety_status !== 'breached', 'KNOWN_SAFETY_BREACH'],
    [input.package_eligibility === 'eligible', 'PACKAGE_NOT_VERIFIED'],
    [input.transport_scope_snapshot_sha256 !== undefined, 'NO_TRANSPORT_SCOPE_SNAPSHOT'],
  ];
  return rows.filter(([holds]) => !holds).map(([, code]) => code);
}

describe('the probe verdict', () => {
  it('follows the exact BR-RUA-027 precedence for any condition outcomes', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TRIAL_VALIDITIES),
        conditionsArbitrary,
        fc.constantFrom(...APPLICABLE_GATE_VALUES),
        (validity, conditions, integrity) => {
          assert.equal(
            deriveProbeVerdict(validity, conditions, integrity),
            specVerdict(validity, conditions, integrity),
          );
        },
      ),
      fuzzParameters(),
    );
  });

  it('builds a schema-valid result whose verdict follows from its parts for any probe edits', () => {
    fc.assert(
      fc.property(journalEditsArbitrary, (edits) => {
        const result = buildProbeResult({ evidence: editedProbeEvidence(edits), checked_at: CHECKED_AT });
        assert.equal(result.ok, true);
        const record = result.value;
        const validation = GOLDEN_VALIDATOR.validateAs('transport_probe_result', record as unknown as JsonValue);
        assert.equal(validation.valid, true, JSON.stringify(validation.valid ? [] : validation.violations));
        record.condition_results.forEach(assertWellFormedCondition);
        assert.equal(
          record.transport_probe_verdict,
          specVerdict(record.probe_validity, record.condition_results, record.evidence_integrity),
        );
      }),
      fuzzParameters(),
    );
  });
});

describe('probe usability', () => {
  it('is usable exactly when every BR-RUA-026 row holds, naming each unmet row in order', () => {
    fc.assert(
      fc.property(usabilityArbitrary, (input) => {
        const assessment = assessProbeUsability(input);
        const expected = unmetRows(input);
        assert.equal(assessment.probe_usability, expected.length === 0 ? 'usable' : 'not_usable');
        assert.deepEqual(
          assessment.reasons.map((reason) => reason.code),
          expected,
        );
        const validation = GOLDEN_VALIDATOR.validateAs(
          'probe_usability_assessment',
          assessment as unknown as JsonValue,
        );
        assert.equal(validation.valid, true, JSON.stringify(validation.valid ? [] : validation.violations));
      }),
      fuzzParameters(),
    );
  });
});
