// Gate G6 `settlement` (BR-RUA-032, D-17, D-32): the runner's assessment must agree with the
// re-derivation from the frozen samples, settlement must be established, and a terminal reason
// must be derivable.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveProcessingTerminalReason } from '../../../src/trial-oracle/processing-terminal-reason.ts';
import type { TerminalReasonDerivation } from '../../../src/trial-oracle/processing-terminal-reason.ts';
import { assessSettlementGate } from '../../../src/trial-oracle/settlement-gate.ts';
import { readTrialSettlement } from '../../../src/trial-oracle/trial-settlement.ts';
import type { TrialSettlement } from '../../../src/trial-oracle/trial-settlement.ts';
import { builtEvidence } from './support/built-trials.ts';
import type { TrialBuild } from './support/built-trials.ts';
import { subjectRecord, textMember } from './support/trial-edits.ts';
import { ACTIVE_CONTROL, CONVENTIONAL_CONTROL, edited } from './support/trial-plans.ts';

const RUNNER = 'runner/runner-journal.jsonl';
const NO_TERMINAL_PROBLEM = { reason: 'SUCCEEDED', reasons: [], evidence_refs: [] } as const;

function facts(build: TrialBuild): {
  readonly settlement: TrialSettlement;
  readonly terminal: TerminalReasonDerivation;
} {
  const evidence = builtEvidence(build);
  return { settlement: readTrialSettlement(evidence), terminal: deriveProcessingTerminalReason(evidence) };
}

function withoutRunnerRecord(recordType: string): TrialBuild {
  const record = subjectRecord(CONVENTIONAL_CONTROL, RUNNER, recordType);
  return edited(CONVENTIONAL_CONTROL, [
    { op: 'remove_record', path: RUNNER, select: { event_id: textMember(record, 'event_id') } },
    { op: 'resequence', path: RUNNER },
  ]);
}

const codes = (gate: ReturnType<typeof assessSettlementGate>): readonly string[] =>
  gate.reasons.map((reason) => reason.code);

describe('assessSettlementGate', () => {
  it('verifies an established settlement the runner assessed alike, with a terminal reason', () => {
    const { settlement, terminal } = facts(CONVENTIONAL_CONTROL);
    const gate = assessSettlementGate(settlement, terminal);
    assert.equal(gate.gate, 'settlement');
    assert.equal(gate.value, 'verified');
    assert.deepEqual(gate.reasons, []);
    const events = gate.evidence_refs.flatMap((ref) => (ref.event_id === undefined ? [] : [ref.event_id]));
    assert.ok(events.includes(subjectRecord(CONVENTIONAL_CONTROL, RUNNER, 'settlement_assessed')['event_id'] as never));
    assert.ok(
      events.includes(subjectRecord(CONVENTIONAL_CONTROL, RUNNER, 'trial_message_published')['event_id'] as never),
    );
  });

  it('leaves absent samples unverified with ARTIFACT_MISSING', () => {
    const { settlement } = facts(
      edited(CONVENTIONAL_CONTROL, [{ op: 'delete_file', path: '$trial/settlement/settlement-samples.jsonl' }]),
    );
    const gate = assessSettlementGate(settlement, NO_TERMINAL_PROBLEM);
    assert.equal(gate.value, 'unverified');
    assert.deepEqual(codes(gate), ['ARTIFACT_MISSING']);
  });

  it('leaves an unrecorded publication unverified at the runner journal', () => {
    const { settlement } = facts(withoutRunnerRecord('trial_message_published'));
    const gate = assessSettlementGate(settlement, NO_TERMINAL_PROBLEM);
    assert.equal(gate.value, 'unverified');
    assert.deepEqual(codes(gate), ['PUBLICATION_NOT_RECORDED']);
    assert.equal(gate.reasons[0]?.artifact_path, RUNNER);
    assert.equal(gate.evidence_refs.length, 1);
  });

  it('leaves an unassessed settlement unverified at the runner journal', () => {
    const { settlement } = facts(withoutRunnerRecord('settlement_assessed'));
    const gate = assessSettlementGate(settlement, NO_TERMINAL_PROBLEM);
    assert.equal(gate.value, 'unverified');
    assert.deepEqual(codes(gate), ['SETTLEMENT_NOT_ASSESSED']);
  });

  it('names the absent runner journal once when neither runner record can exist', () => {
    const { settlement } = facts(CONVENTIONAL_CONTROL);
    const runnerless: TrialSettlement = {
      samples: settlement.samples,
      runner_journal: { artifact_class: 'runner_journal', path: RUNNER, complete: false },
    };
    const gate = assessSettlementGate(runnerless, NO_TERMINAL_PROBLEM);
    assert.equal(gate.value, 'unverified');
    assert.deepEqual(codes(gate), ['ARTIFACT_MISSING']);
    assert.equal(gate.reasons[0]?.artifact_path, RUNNER);
  });

  it('adds the terminal-reason problems to the missing-settlement ones', () => {
    const { settlement } = facts(withoutRunnerRecord('settlement_assessed'));
    const { terminal } = facts(ACTIVE_CONTROL);
    const gate = assessSettlementGate(settlement, terminal);
    assert.deepEqual(codes(gate).toSorted(), ['PROCESSING_NOT_TERMINAL', 'SETTLEMENT_NOT_ASSESSED']);
  });

  it('invalidates a runner assessment whose window the samples do not re-derive', () => {
    const assessed = subjectRecord(CONVENTIONAL_CONTROL, RUNNER, 'settlement_assessed');
    const shifted = new Date(Date.parse(textMember(assessed, 'established_at')) + 1000).toISOString();
    const { settlement, terminal } = facts(
      edited(CONVENTIONAL_CONTROL, [
        {
          op: 'set',
          path: RUNNER,
          select: { event_id: textMember(assessed, 'event_id') },
          pointer: '/established_at',
          value: shifted,
        },
      ]),
    );
    const gate = assessSettlementGate(settlement, terminal);
    assert.equal(gate.value, 'invalid');
    assert.deepEqual(codes(gate), ['SETTLEMENT_REDERIVATION_MISMATCH']);
    assert.equal(gate.reasons[0]?.event_id, assessed['event_id']);
    assert.match(
      gate.reasons[0]?.detail ?? '',
      /the frozen samples re-derive established .*; expected the same judgement/,
    );
  });

  it('invalidates a runner claim of establishment the samples re-derive as not established', () => {
    const settled = facts(CONVENTIONAL_CONTROL);
    const active = facts(ACTIVE_CONTROL);
    assert.ok(active.settlement.derived !== undefined);
    const gate = assessSettlementGate(
      { ...settled.settlement, derived: active.settlement.derived },
      NO_TERMINAL_PROBLEM,
    );
    assert.equal(gate.value, 'invalid');
    assert.match(gate.reasons[0]?.detail ?? '', /re-derive not established; expected the same judgement/);
  });

  it('leaves a runner not_established against an established re-derivation unverified', () => {
    const settled = facts(CONVENTIONAL_CONTROL);
    const active = facts(ACTIVE_CONTROL);
    assert.ok(active.settlement.assessed !== undefined);
    const gate = assessSettlementGate(
      { ...settled.settlement, assessed: active.settlement.assessed },
      NO_TERMINAL_PROBLEM,
    );
    assert.equal(gate.value, 'unverified');
    assert.deepEqual(codes(gate), ['SETTLEMENT_NOT_ESTABLISHED']);
    assert.match(gate.reasons[0]?.detail ?? '', /assessed not_established although the samples re-derive established/);
  });

  it('reports each re-derived cause at the runner assessment when neither found a settled window', () => {
    const { settlement, terminal } = facts(ACTIVE_CONTROL);
    const gate = assessSettlementGate(settlement, terminal);
    assert.equal(gate.value, 'unverified');
    assert.ok(codes(gate).includes('PROCESSING_NOT_TERMINAL'));
    const assessedId = settlement.assessed?.record.event_id;
    const atAssessment = gate.reasons.filter((reason) => reason.event_id === assessedId);
    assert.ok(atAssessment.length > 0);
    assert.ok(atAssessment.every((reason) => reason.subject === 'BR-RUA-032' && reason.artifact_path === RUNNER));
  });
});
