// The probe's evidence integrity (design §8.11) and its two local inputs: ledger access G5 and
// settlement under the probe policy (BR-RUA-032).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GateCause } from '../../../../src/evidence-ingestion/gate-assessment.ts';
import { assessProbeEvidenceIntegrity } from '../../../../src/transport-qualification/verdict/probe-evidence-integrity.ts';
import { assessProbeLedgerAccess } from '../../../../src/transport-qualification/verdict/probe-ledger-access.ts';
import { probeSettlementCauses } from '../../../../src/transport-qualification/verdict/probe-settlement.ts';
import { assessProbeValidity } from '../../../../src/transport-qualification/verdict/probe-validity.ts';
import type { ScenarioOperation } from '../../../support/golden-builder/operation-parsing.ts';
import { probeEvidence, removeOp, setOp, SUBJECT_FILES } from '../../treatment-fidelity/support/treatment-evidence.ts';
import { PROBE_EDITS } from '../../treatment-fidelity/support/treatment-scenarios.ts';
import { codes, present } from '../../treatment-fidelity/support/view-edits.ts';

/** The base probe runner's `probe_workload_invoked` and `settlement_assessed` event ids. */
const INVOCATION_EVENT_ID = '12362de2-5a0a-4320-9a52-942df0610bd3';
const ASSESSMENT_EVENT_ID = 'd5713153-f94b-480b-a711-3241c3e6071d';

/** The runner claims establishment at 12:07:05; the frozen samples establish it at 12:07:35. */
const RUNNER_CLAIMS_EARLIER_ESTABLISHMENT = setOp(
  SUBJECT_FILES.runner,
  'settlement_assessed',
  '/established_at',
  '2026-10-05T12:07:05.000Z',
);

/** The frozen pre-freeze recheck (line 6) saw a provider call still active. */
const RECHECK_NOT_QUIET: ScenarioOperation = {
  op: 'set',
  path: SUBJECT_FILES.samples,
  select: { line: 6 },
  pointer: '/provider_active_calls',
  value: 1,
};

/** The runner journal without its `probe_workload_invoked`, renumbered so no gap remains. */
const NO_INVOCATION: readonly ScenarioOperation[] = [
  removeOp(SUBJECT_FILES.runner, 'probe_workload_invoked'),
  { op: 'resequence', path: SUBJECT_FILES.runner },
];

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

  // Review regression (WP-10): the runner's `settlement_assessed` was trusted without re-deriving
  // it from the frozen samples, so a runner claim the samples contradict verified the probe.
  it('is unverified with SETTLEMENT_REDERIVATION_MISMATCH when the runner claims another instant', () => {
    const causes = probeSettlementCauses(probeEvidence([RUNNER_CLAIMS_EARLIER_ESTABLISHMENT]));
    assert.deepEqual(causeCodes(causes), [['unverified', 'SETTLEMENT_REDERIVATION_MISMATCH']]);
    const cause = present(causes[0], 'settlement cause');
    assert.equal(cause.reason.subject, 'BR-RUA-032');
    assert.equal(cause.reason.artifact_path, 'runner/runner-journal.jsonl');
    assert.equal(cause.reason.event_id, ASSESSMENT_EVENT_ID);
    assert.equal(
      cause.reason.detail,
      'the runner assessed established 2026-10-05T12:05:35.000Z..2026-10-05T12:07:05.000Z, rechecked ' +
        '2026-10-05T12:07:40.000Z; the frozen samples re-derive established ' +
        '2026-10-05T12:05:35.000Z..2026-10-05T12:07:35.000Z, rechecked 2026-10-05T12:07:40.000Z under the ' +
        'probe policy; expected the same judgement',
    );
    assert.deepEqual(
      cause.refs.map((ref) => [ref.artifact_path, ref.event_id]),
      [
        ['probe/settlement/settlement-samples.jsonl', undefined],
        ['runner/runner-journal.jsonl', INVOCATION_EVENT_ID],
        ['runner/runner-journal.jsonl', ASSESSMENT_EVENT_ID],
      ],
    );
  });

  it('is unverified when the runner claims settlement over samples that never settled', () => {
    const causes = probeSettlementCauses(probeEvidence([RECHECK_NOT_QUIET]));
    assert.deepEqual(causeCodes(causes), [['unverified', 'SETTLEMENT_REDERIVATION_MISMATCH']]);
    assert.match(causes[0]?.reason.detail ?? '', /the frozen samples re-derive not established \([A-Z_, ]+\)/u);
  });

  it('flags a mismatch on each instant the runner reports', () => {
    for (const pointer of ['/window_start', '/rechecked_at']) {
      const edit = setOp(SUBJECT_FILES.runner, 'settlement_assessed', pointer, '2026-10-05T12:07:38.000Z');
      assert.deepEqual(causeCodes(probeSettlementCauses(probeEvidence([edit]))), [
        ['unverified', 'SETTLEMENT_REDERIVATION_MISMATCH'],
      ]);
    }
  });

  it('counts the observation deadline from the workload invocation', () => {
    const invokedLongBefore = setOp(
      SUBJECT_FILES.runner,
      'probe_workload_invoked',
      '/occurred_at',
      '2026-10-05T11:55:00.000Z',
    );
    const causes = probeSettlementCauses(probeEvidence([invokedLongBefore]));
    assert.deepEqual(causeCodes(causes), [['unverified', 'SETTLEMENT_REDERIVATION_MISMATCH']]);
    assert.match(causes[0]?.reason.detail ?? '', /re-derive not established \(DEADLINE\)/u);
  });

  it('is unverified with WORKLOAD_INVOCATION_NOT_RECORDED without the runner invocation', () => {
    const causes = probeSettlementCauses(probeEvidence(NO_INVOCATION));
    assert.deepEqual(causeCodes(causes), [['unverified', 'WORKLOAD_INVOCATION_NOT_RECORDED']]);
    const cause = present(causes[0], 'settlement cause');
    assert.equal(cause.reason.artifact_path, 'runner/runner-journal.jsonl');
    assert.equal(
      cause.reason.detail,
      "the runner journal has no probe_workload_invoked for the probe; expected the runner's record",
    );
  });

  it('names every missing runner record, and a non-established claim beside them', () => {
    const neither = [...NO_INVOCATION, ...PROBE_EDITS.settlement_not_assessed];
    assert.deepEqual(causeCodes(probeSettlementCauses(probeEvidence(neither))), [
      ['unverified', 'WORKLOAD_INVOCATION_NOT_RECORDED'],
      ['unverified', 'SETTLEMENT_NOT_ASSESSED'],
    ]);
    const notEstablished = [...PROBE_EDITS.settlement_not_established, ...NO_INVOCATION];
    assert.deepEqual(causeCodes(probeSettlementCauses(probeEvidence(notEstablished))), [
      ['unverified', 'WORKLOAD_INVOCATION_NOT_RECORDED'],
      ['unverified', 'SETTLEMENT_NOT_ESTABLISHED'],
    ]);
  });

  it('does not re-derive from partial samples', () => {
    const causes = probeSettlementCauses(probeEvidence([...PROBE_EDITS.unreadable_samples, RECHECK_NOT_QUIET]));
    assert.deepEqual(causeCodes(causes), [['unverified', 'ARTIFACT_INCOMPLETE']]);
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

  it('is unverified when the frozen samples do not re-derive the runner settlement', () => {
    const integrity = integrityOf([RUNNER_CLAIMS_EARLIER_ESTABLISHMENT]);
    assert.equal(integrity.value, 'unverified');
    assert.deepEqual(codes(integrity.reasons), ['SETTLEMENT_REDERIVATION_MISMATCH']);
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
