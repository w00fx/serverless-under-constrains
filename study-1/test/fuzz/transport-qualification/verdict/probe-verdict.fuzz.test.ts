// Design §12.5 and §8.11 as properties: the exact BR-RUA-027 verdict precedence over arbitrary
// condition outcomes; the probe result over arbitrary probe edits is a valid
// `transport_probe_result` whose verdict follows from its own parts (CTR-RUA-003), counts distinct
// ledger transactions and claims verified evidence only over a settlement the frozen samples
// re-derive (BR-RUA-032); the probe validity over any ledger rows follows BR-RUA-027's cardinality;
// and BR-RUA-026 usability holds exactly when every row holds, with one reason per unmet row in
// table order.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { IngestedEvidence } from '../../../../src/evidence-ingestion/ingestion-model.ts';
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
import type { TransportProbeResult } from '../../../../src/record-contract/records/group-c/transport_probe_result.ts';
import { evaluateSettlement } from '../../../../src/settlement/evaluate-settlement.ts';
import { PROBE_SETTLEMENT_POLICY } from '../../../../src/settlement/settlement-policy.ts';
import { eventsOfType, partitionEvents } from '../../../../src/treatment-fidelity/subject-events.ts';
import { evaluateTreatmentConditions } from '../../../../src/treatment-fidelity/treatment-conditions.ts';
import { buildProbeResult } from '../../../../src/transport-qualification/verdict/probe-result.ts';
import { assessProbeUsability } from '../../../../src/transport-qualification/verdict/probe-usability.ts';
import type { ProbeUsabilityInput } from '../../../../src/transport-qualification/verdict/probe-usability.ts';
import { assessProbeValidity } from '../../../../src/transport-qualification/verdict/probe-validity.ts';
import { deriveProbeVerdict } from '../../../../src/transport-qualification/verdict/probe-verdict.ts';
import { GOLDEN_VALIDATOR } from '../../../golden/transport-qualification/verdict/support/probe-golden.ts';
import { fuzzParameters } from '../../../support/kernel/fuzz-parameters.ts';
import {
  documentOp,
  PROBE_IDS,
  probeEvidence,
  SUBJECT_FILES,
  treatmentView,
} from '../../../unit/treatment-fidelity/support/treatment-evidence.ts';
import { LEDGER_TRANSACTION } from '../../../unit/treatment-fidelity/support/treatment-scenarios.ts';
import { assertWellFormedCondition } from '../../../unit/treatment-fidelity/support/view-edits.ts';
import {
  countedEditsArbitrary,
  editedProbeEvidence,
  journalEditsArbitrary,
} from '../../treatment-fidelity/support/journal-edits.ts';

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
        wellFormedResult(editedProbeEvidence(edits));
      }),
      fuzzParameters(),
    );
  });

  it('counts distinct transactions and verifies only a re-derived settlement for any counted edits', () => {
    fc.assert(
      fc.property(countedEditsArbitrary, (edits) => {
        const evidence = editedProbeEvidence(edits);
        const record = wellFormedResult(evidence);
        const ledger = evidence.ledger;
        const distinct = new Set(ledger.transactions.map((transaction) => transaction.provider_transaction_id));
        assert.equal(record.probe_cardinality.committed_transactions, distinct.size);
        if (ledger.duplicate_transaction_ids.length > 0) {
          assert.notEqual(record.probe_validity, 'valid');
        }
        if (record.evidence_integrity === 'verified') {
          assert.equal(rederivedSettlement(evidence), 'established');
        }
      }),
      fuzzParameters(),
    );
  });

  it('judges any ledger rows by their distinct transaction ids (BR-RUA-027 cardinality)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(PROBE_IDS.transaction, PROBE_IDS.absent), { minLength: 1, maxLength: 4 }),
        (ids) => {
          const validity = assessProbeValidity(probeEvidence(ledgerRows(ids)));
          const distinct = new Set(ids).size;
          assert.equal(validity.cardinality.committed_transactions, distinct);
          const expected = distinct > 1 ? 'invalid' : distinct < ids.length ? 'indeterminate' : 'valid';
          assert.equal(validity.probe_validity, expected);
          const codes = validity.reasons.map((reason) => reason.code);
          assert.deepEqual(
            codes,
            { invalid: ['PROBE_CARDINALITY_EXCEEDED'], indeterminate: ['LEDGER_NOT_USABLE'], valid: [] }[expected],
          );
        },
      ),
      fuzzParameters(),
    );
  });
});

/** The probe result of `evidence`, asserted schema-valid with a verdict that follows from its parts. */
function wellFormedResult(evidence: IngestedEvidence): TransportProbeResult {
  const result = buildProbeResult({ evidence, checked_at: CHECKED_AT });
  assert.equal(result.ok, true);
  const record = result.value;
  const validation = GOLDEN_VALIDATOR.validateAs('transport_probe_result', record as unknown as JsonValue);
  assert.equal(validation.valid, true, JSON.stringify(validation.valid ? [] : validation.violations));
  record.condition_results.forEach(assertWellFormedCondition);
  assert.equal(
    record.transport_probe_verdict,
    specVerdict(record.probe_validity, record.condition_results, record.evidence_integrity),
  );
  return record;
}

// The shared evaluator's judgement of the frozen samples under the probe policy, counted from the
// runner's first workload invocation: the oracle a verified probe must agree with (BR-RUA-032).
function rederivedSettlement(evidence: IngestedEvidence): string {
  const invoked = eventsOfType(partitionEvents(evidence), 'probe_workload_invoked')[0];
  if (invoked === undefined) {
    return 'no invocation';
  }
  const samples = evidence.observations.settlement_samples.map((located) => located.record);
  return evaluateSettlement(samples, PROBE_SETTLEMENT_POLICY, invoked.record.occurred_at).status;
}

/** The ledger edited to hold one row per id, in order, with a page count that agrees. */
function ledgerRows(ids: readonly string[]): Parameters<typeof probeEvidence>[0] {
  return [
    documentOp(
      SUBJECT_FILES.ledger,
      '/transactions',
      ids.map((id) => ({ ...LEDGER_TRANSACTION, provider_transaction_id: id })),
    ),
    documentOp(SUBJECT_FILES.ledger, '/pages/0/item_count', ids.length),
  ];
}

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
