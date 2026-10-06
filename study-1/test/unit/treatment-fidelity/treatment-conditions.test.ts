// The six conditions in their fixed order, CA-1 and the always-applicable gate assembly (design
// §8.10, D-05, AC-RUA-002).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GateCause } from '../../../src/evidence-ingestion/gate-assessment.ts';
import type { EvidenceRef } from '../../../src/record-contract/evidence-refs.ts';
import { CA_1_SCOPE, CA_1_STATEMENT } from '../../../src/record-contract/records/group-a/execution_manifest.ts';
import type { Sha256Hex } from '../../../src/record-contract/primitives.ts';
import { assembleApplicableGate } from '../../../src/treatment-fidelity/applicable-gate.ts';
import {
  CA_1,
  TREATMENT_CLOCK_ASSUMPTION_REFS,
  TREATMENT_FIDELITY_BASIS,
  TREATMENT_ORDERING_BASIS,
} from '../../../src/treatment-fidelity/clock-assumption.ts';
import { evaluateTreatmentConditions } from '../../../src/treatment-fidelity/treatment-conditions.ts';
import { probeEvidence, treatmentView } from './support/treatment-evidence.ts';

const REF: EvidenceRef = {
  artifact_path: 'probe/ledger/ledger-snapshot.json',
  artifact_sha256: 'c'.repeat(64) as Sha256Hex,
};

function cause(value: GateCause['value'], code: string): GateCause {
  return { value, reason: { code, subject: 'BR-RUA-025', detail: `${code} for the test` }, refs: [REF] };
}

describe('evaluateTreatmentConditions', () => {
  it('evaluates BR-RUA-010 to BR-RUA-015 in that order', () => {
    const conditions = evaluateTreatmentConditions(treatmentView(probeEvidence()));
    assert.deepEqual(
      conditions.map((condition) => condition.condition_id),
      ['BR-RUA-010', 'BR-RUA-011', 'BR-RUA-012', 'BR-RUA-013', 'BR-RUA-014', 'BR-RUA-015'],
    );
    assert.ok(conditions.every((condition) => condition.result === 'pass'));
  });
});

describe('CA-1 and the treatment basis', () => {
  it('declares CA-1 as a clock-alignment study assumption, not a service guarantee', () => {
    assert.deepEqual(CA_1, {
      assumption_id: 'CA-1',
      assumption_type: 'clock_alignment',
      scope: CA_1_SCOPE,
      statement: CA_1_STATEMENT,
      status: 'declared_not_service_guaranteed',
    });
  });

  it('orders by cross-source wall clock under CA-1, never by happened-before proof', () => {
    assert.equal(TREATMENT_FIDELITY_BASIS, 'causal_plus_cross_source_clock_assumption');
    assert.deepEqual(TREATMENT_CLOCK_ASSUMPTION_REFS, ['CA-1']);
    assert.equal(TREATMENT_ORDERING_BASIS, 'cross_source_wall_clock');
  });
});

describe('assembleApplicableGate', () => {
  it('is verified without causes and cites the verified references', () => {
    const gate = assembleApplicableGate('treatment_fidelity', [], [REF]);
    assert.deepEqual(gate, { gate: 'treatment_fidelity', value: 'verified', reasons: [], evidence_refs: [REF] });
  });

  it('is unverified with only unverified causes', () => {
    const gate = assembleApplicableGate('evidence_integrity', [cause('unverified', 'ARTIFACT_MISSING')], []);
    assert.equal(gate.value, 'unverified');
    assert.deepEqual(
      gate.reasons.map((reason) => reason.code),
      ['ARTIFACT_MISSING'],
    );
  });

  it('is invalid when any cause is invalid', () => {
    const gate = assembleApplicableGate(
      'treatment_fidelity',
      [cause('unverified', 'ARTIFACT_MISSING'), cause('invalid', 'CONDITION_FAILED')],
      [],
    );
    assert.equal(gate.value, 'invalid');
    assert.ok(gate.reasons.some((reason) => reason.code === 'CONDITION_FAILED'));
  });
});
