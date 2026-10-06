// AC-RUA-046 (group C): the closed vocabularies the group-C records use equal the spec's literal
// lists. catalogue.contract.test.ts ties every schema enum to its exported tuple; this file ties
// the tuples to the spec text, so a value added to or dropped from both the tuple and the schema
// still fails here (addendum §6: expectations come from the spec, never from the implementation).
// Each expected list below is copied verbatim, in order, from the named spec section.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GATE_VALUES } from '../../../../src/record-contract/primitives.ts';
import { SAFETY_RESULTS } from '../../../../src/record-contract/records/group-b/vocabulary.ts';
import * as groupC from '../../../../src/record-contract/records/group-c/vocabulary.ts';

type SpecVocabulary = readonly [string, readonly (string | number)[], readonly string[]];

const SPEC_VOCABULARIES: readonly SpecVocabulary[] = [
  [
    'CTR-RUA-002 canonical run terminal reasons',
    groupC.RUN_TERMINAL_REASONS,
    [
      'COMPLETED',
      'LEASE_ACQUISITION_FAILED',
      'LEASE_LOST',
      'PROVISIONING_FAILED',
      'TRIAL_INCOMPLETE',
      'SAFETY_DEADLINE',
      'OPERATOR_ABORT',
      'INTERRUPTED',
      'CLEANUP_INCOMPLETE',
      'LEAK_AUDIT_NOT_CLEAN',
      'EVIDENCE_FINALIZATION_FAILED',
    ],
  ],
  ['CTR-RUA-002 execution_status', groupC.EXECUTION_STATUSES, ['completed', 'incomplete']],
  [
    'CTR-RUA-002 comparison_eligibility, BR-RUA-044 package_eligibility',
    groupC.ELIGIBILITIES,
    ['eligible', 'ineligible'],
  ],
  [
    'CTR-RUA-003 probe terminal reasons',
    groupC.PROBE_TERMINAL_REASONS,
    [
      'COMPLETED',
      'LEASE_ACQUISITION_FAILED',
      'LEASE_LOST',
      'PROVISIONING_FAILED',
      'PROBE_INCOMPLETE',
      'SAFETY_DEADLINE',
      'OPERATOR_ABORT',
      'INTERRUPTED',
      'CLEANUP_INCOMPLETE',
      'LEAK_AUDIT_NOT_CLEAN',
      'EVIDENCE_FINALIZATION_FAILED',
    ],
  ],
  ['CTR-RUA-003 transport_probe_verdict', groupC.PRESERVATION_VERDICTS, ['pass', 'fail', 'indeterminate']],
  [
    'CTR-RUA-003 probe_validity, BR-RUA-029 aggregate validity, BR-RUA-038 validation_validity',
    groupC.TRIAL_VALIDITIES,
    ['valid', 'invalid', 'indeterminate'],
  ],
  ['CTR-RUA-003 evidence_integrity', groupC.APPLICABLE_GATE_VALUES, ['verified', 'invalid', 'unverified']],
  [
    'BR-RUA-038 implementation_validation_status',
    groupC.IMPLEMENTATION_VALIDATION_STATUSES,
    ['verified', 'failed', 'indeterminate'],
  ],
  [
    'BR-RUA-038 canonical validation terminal reasons',
    groupC.VALIDATION_TERMINAL_REASONS,
    [
      'COMPLETED',
      'LEASE_ACQUISITION_FAILED',
      'LEASE_LOST',
      'LEASE_RELEASE_FAILED',
      'LEASE_STATE_UNVERIFIED',
      'PROVISIONING_FAILED',
      'VALIDATION_INCOMPLETE',
      'SAFETY_DEADLINE',
      'SAFETY_LIMIT_EXCEEDED',
      'OPERATOR_ABORT',
      'INTERRUPTED',
      'CLEANUP_INCOMPLETE',
      'LEAK_AUDIT_NOT_CLEAN',
      'EVIDENCE_FINALIZATION_FAILED',
    ],
  ],
  [
    'BR-RUA-043 late evidence assessment',
    groupC.LATE_EVIDENCE_STATUSES,
    ['none', 'consistent', 'contradictory', 'unverified'],
  ],
  ['BR-RUA-045 final lease status', groupC.LEASE_STATUSES, ['released', 'recovery_required', 'unverified']],
  ['BR-RUA-046 safety status', SAFETY_RESULTS, ['within_limits', 'breached', 'unverified']],
  ['BR-RUA-047 billed_cost_check', groupC.BILLED_COST_CHECKS, ['within_limit', 'breached', 'unverified']],
  ['BR-RUA-051 cleanup status', groupC.CLEANUP_STATUSES, ['not_started', 'running', 'succeeded', 'partial', 'failed']],
  ['BR-RUA-051 leak-audit status', groupC.LEAK_AUDIT_STATUSES, ['clean', 'leaks_detected', 'inconclusive']],
  [
    'BR-RUA-025 fidelity_basis',
    groupC.FIDELITY_BASES,
    ['causal_plus_cross_source_clock_assumption', 'causal', 'not_applicable'],
  ],
  ['BR-RUA-025 CA-1', groupC.CLOCK_ASSUMPTION_IDS, ['CA-1']],
  ['BR-RUA-010 ordering_basis', groupC.ORDERING_BASES, ['cross_source_wall_clock']],
  [
    'BR-RUA-029 individual gates, BR-RUA-025 control integrity and treatment fidelity',
    GATE_VALUES,
    ['verified', 'invalid', 'unverified', 'not_applicable'],
  ],
  [
    'BR-RUA-010 to BR-RUA-015 transport conditions',
    groupC.CONDITION_IDS,
    ['BR-RUA-010', 'BR-RUA-011', 'BR-RUA-012', 'BR-RUA-013', 'BR-RUA-014', 'BR-RUA-015'],
  ],
];

describe('AC-RUA-046 group-C closed vocabularies equal the spec lists', () => {
  for (const [source, exported, spec] of SPEC_VOCABULARIES) {
    it(source, () => {
      assert.deepEqual([...exported], [...spec], source);
    });
  }

  it('covers every spec vocabulary named in the review (CTR-RUA-002/003, BR-RUA-038/043/045/046/047/051)', () => {
    assert.equal(SPEC_VOCABULARIES.length, 20);
  });
});
