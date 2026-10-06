// The probe's evidence integrity (design §8.11) and its two local inputs: ledger access G5 and
// settlement under the probe policy (BR-RUA-032).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GateCause } from '../../../../src/evidence-ingestion/gate-assessment.ts';
import { assessProbeEvidenceIntegrity } from '../../../../src/transport-qualification/verdict/probe-evidence-integrity.ts';
import { assessProbeLedgerAccess } from '../../../../src/transport-qualification/verdict/probe-ledger-access.ts';
import { probeSettlementCauses } from '../../../../src/transport-qualification/verdict/probe-settlement.ts';
import { assessProbeValidity } from '../../../../src/transport-qualification/verdict/probe-validity.ts';
import { probeEvidence } from '../../treatment-fidelity/support/treatment-evidence.ts';
import { PROBE_EDITS } from '../../treatment-fidelity/support/treatment-scenarios.ts';
import { codes, present } from '../../treatment-fidelity/support/view-edits.ts';

function causeCodes(causes: readonly GateCause[]): readonly (readonly [string, string])[] {
  return causes.map((cause) => [cause.value, cause.reason.code] as const);
}

function integrityOf(
  operations: Parameters<typeof probeEvidence>[0] = [],
): ReturnType<typeof assessProbeEvidenceIntegrity> {
  const evidence = probeEvidence(operations);
  return assessProbeEvidenceIntegrity(evidence, assessProbeValidity(evidence));
}

describe('assessProbeLedgerAccess (G5)', () => {
  it('is verified for a complete, consistent, duplicate-free snapshot', () => {
    const gate = assessProbeLedgerAccess(probeEvidence());
    assert.equal(gate.value, 'verified');
    assert.deepEqual(
      gate.evidence_refs.map((ref) => ref.artifact_path),
      ['probe/ledger/ledger-snapshot.json'],
    );
  });

  it('is invalid with DUPLICATE_LEDGER_TRANSACTION_ID', () => {
    const gate = assessProbeLedgerAccess(probeEvidence(PROBE_EDITS.ledger_duplicate));
    assert.equal(gate.value, 'invalid');
    assert.deepEqual(codes(gate.reasons), ['DUPLICATE_LEDGER_TRANSACTION_ID']);
  });

  it('is unverified with LEDGER_PAGINATION_INCOMPLETE', () => {
    const gate = assessProbeLedgerAccess(probeEvidence(PROBE_EDITS.ledger_incomplete));
    assert.equal(gate.value, 'unverified');
    assert.deepEqual(codes(gate.reasons), ['LEDGER_PAGINATION_INCOMPLETE']);
  });

  it('is unverified with LEDGER_READ_NOT_CONSISTENT', () => {
    const gate = assessProbeLedgerAccess(probeEvidence(PROBE_EDITS.ledger_inconsistent));
    assert.equal(gate.value, 'unverified');
    assert.deepEqual(codes(gate.reasons), ['LEDGER_READ_NOT_CONSISTENT']);
  });

  it('is unverified with ARTIFACT_MISSING without the snapshot', () => {
    const gate = assessProbeLedgerAccess(probeEvidence(PROBE_EDITS.no_ledger));
    assert.equal(gate.value, 'unverified');
    assert.deepEqual(codes(gate.reasons), ['ARTIFACT_MISSING']);
    assert.deepEqual(gate.evidence_refs, []);
  });

  it('is unverified when a present view has no snapshot record', () => {
    const evidence = probeEvidence();
    const { snapshot: _snapshot, ...ledger } = evidence.ledger;
    const gate = assessProbeLedgerAccess({ ...evidence, ledger });
    assert.deepEqual(codes(gate.reasons), ['LEDGER_READ_NOT_CONSISTENT']);
  });
});

describe('probeSettlementCauses', () => {
  it('finds nothing when the runner established settlement over present samples', () => {
    assert.deepEqual(probeSettlementCauses(probeEvidence()), []);
  });

  it('is unverified with SETTLEMENT_NOT_ESTABLISHED', () => {
    const causes = probeSettlementCauses(probeEvidence(PROBE_EDITS.settlement_not_established));
    assert.deepEqual(causeCodes(causes), [['unverified', 'SETTLEMENT_NOT_ESTABLISHED']]);
    assert.notEqual(causes[0]?.reason.event_id, undefined);
  });

  it('is unverified with SETTLEMENT_NOT_ASSESSED when the runner never assessed it', () => {
    const causes = probeSettlementCauses(probeEvidence(PROBE_EDITS.settlement_not_assessed));
    assert.deepEqual(causeCodes(causes), [['unverified', 'SETTLEMENT_NOT_ASSESSED']]);
    assert.equal(causes[0]?.reason.artifact_path, 'runner/runner-journal.jsonl');
  });

  it('is unverified with ARTIFACT_INCOMPLETE for unreadable samples, citing them', () => {
    const causes = probeSettlementCauses(probeEvidence(PROBE_EDITS.unreadable_samples));
    assert.deepEqual(causeCodes(causes), [['unverified', 'ARTIFACT_INCOMPLETE']]);
    assert.deepEqual(
      causes[0]?.refs.map((ref) => ref.artifact_path),
      ['probe/settlement/settlement-samples.jsonl'],
    );
  });

  it('names the missing runner journal and samples as ARTIFACT_MISSING', () => {
    assert.deepEqual(causeCodes(probeSettlementCauses(probeEvidence(PROBE_EDITS.no_runner_journal))), [
      ['unverified', 'ARTIFACT_MISSING'],
    ]);
    const causes = probeSettlementCauses(probeEvidence(PROBE_EDITS.no_samples));
    assert.deepEqual(causeCodes(causes), [['unverified', 'ARTIFACT_MISSING']]);
    const cause = present(causes[0], 'settlement cause');
    assert.equal(cause.reason.artifact_path, 'probe/settlement/settlement-samples.jsonl');
    assert.deepEqual(cause.refs, []);
  });
});

describe('assessProbeEvidenceIntegrity', () => {
  it('is verified for the base probe', () => {
    const integrity = integrityOf();
    assert.equal(integrity.value, 'verified');
    assert.deepEqual(integrity.reasons, []);
    assert.ok(integrity.evidence_refs.length > 0);
  });

  it('is invalid when an ingestion gate or ledger access is invalid', () => {
    const duplicate = integrityOf(PROBE_EDITS.ledger_duplicate);
    assert.equal(duplicate.value, 'invalid');
    assert.ok(codes(duplicate.reasons).includes('DUPLICATE_LEDGER_TRANSACTION_ID'));
    assert.equal(integrityOf(PROBE_EDITS.invalid_outcome_record).value, 'invalid');
  });

  it('is unverified when settlement is not established', () => {
    const integrity = integrityOf(PROBE_EDITS.settlement_not_established);
    assert.equal(integrity.value, 'unverified');
    assert.deepEqual(codes(integrity.reasons), ['SETTLEMENT_NOT_ESTABLISHED']);
  });

  it('is unverified when ledger access is unverified', () => {
    assert.deepEqual(codes(integrityOf(PROBE_EDITS.ledger_inconsistent).reasons), ['LEDGER_READ_NOT_CONSISTENT']);
  });

  it('is unverified with PROBE_WORKLOAD_NOT_EVIDENCED for each count of 0', () => {
    const integrity = integrityOf(PROBE_EDITS.no_ledger);
    assert.equal(integrity.value, 'unverified');
    assert.ok(codes(integrity.reasons).includes('PROBE_WORKLOAD_NOT_EVIDENCED'));
    const evidence = probeEvidence();
    const validity = assessProbeValidity(evidence);
    const idle = {
      ...validity,
      cardinality: { caller_invocations: 0, accepted_provider_calls: 0, committed_transactions: 0 },
    };
    const workload = assessProbeEvidenceIntegrity(evidence, idle).reasons.filter(
      (reason) => reason.code === 'PROBE_WORKLOAD_NOT_EVIDENCED',
    );
    // The gate assembly merges reasons of one code at one location, counting them.
    assert.equal(workload.length, 1);
    assert.match(workload[0]?.detail ?? '', /^caller_invocations is 0.*\(and 2 more\)$/u);
  });
});
