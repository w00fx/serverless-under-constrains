// Gate G7 `rule_evidence` (BR-RUA-029): the caller journal, the ledger snapshot, the payment and the
// approved decision are present and ungapped; nothing makes the gate invalid.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GateAssessment } from '../../../src/evidence-ingestion/ingestion-model.ts';
import { assessRuleEvidence } from '../../../src/trial-oracle/rule-evidence-gate.ts';
import { builtEvidence } from './support/built-trials.ts';
import type { TrialBuild } from './support/built-trials.ts';
import { CONVENTIONAL_CONTROL, edited } from './support/trial-plans.ts';

const assess = (build: TrialBuild): GateAssessment<'rule_evidence'> => assessRuleEvidence(builtEvidence(build));
const located = (gate: ReturnType<typeof assess>): readonly string[] =>
  gate.reasons.map((reason) => `${reason.code} ${(reason.artifact_path ?? '').replace(/^trials\/[0-9a-f-]+\//, '')}`);

describe('assessRuleEvidence', () => {
  it('verifies a trial whose rule inputs are all present, citing the four of them', () => {
    const gate = assess(CONVENTIONAL_CONTROL);
    assert.equal(gate.gate, 'rule_evidence');
    assert.equal(gate.value, 'verified');
    assert.deepEqual(
      gate.evidence_refs.map((ref) => ref.artifact_path.replace(/^trials\/[0-9a-f-]+\//, '')).toSorted(),
      [
        'inputs/approved-decision.json',
        'inputs/payment.json',
        'journals/caller-journal.jsonl',
        'ledger/ledger-snapshot.json',
      ],
    );
  });

  it('leaves an absent caller journal unverified (AC-RUA-007 case 3)', () => {
    const gate = assess(
      edited(CONVENTIONAL_CONTROL, [{ op: 'delete_file', path: '$trial/journals/caller-journal.jsonl' }]),
    );
    assert.equal(gate.value, 'unverified');
    assert.deepEqual(located(gate), ['ARTIFACT_MISSING journals/caller-journal.jsonl']);
    assert.deepEqual(gate.evidence_refs, []);
  });

  it('leaves a gapped caller journal unverified, citing it', () => {
    const gate = assess(
      edited(CONVENTIONAL_CONTROL, [
        {
          op: 'remove_record',
          path: '$trial/journals/caller-journal.jsonl',
          select: { record_type: 'dispatch_started' },
        },
      ]),
    );
    assert.equal(gate.value, 'unverified');
    assert.deepEqual(located(gate), ['ARTIFACT_INCOMPLETE journals/caller-journal.jsonl']);
    assert.equal(gate.evidence_refs.length, 1);
  });

  it('leaves an absent ledger snapshot unverified', () => {
    const gate = assess(
      edited(CONVENTIONAL_CONTROL, [{ op: 'delete_file', path: '$trial/ledger/ledger-snapshot.json' }]),
    );
    assert.deepEqual(located(gate), ['ARTIFACT_MISSING ledger/ledger-snapshot.json']);
  });

  it('names a missing payment and an unreadable decision with INPUT_MISSING', () => {
    const gate = assess(
      edited(CONVENTIONAL_CONTROL, [
        { op: 'delete_file', path: '$trial/inputs/payment.json' },
        { op: 'truncate', path: '$trial/inputs/approved-decision.json', length: 3 },
      ]),
    );
    assert.equal(gate.value, 'unverified');
    assert.deepEqual(located(gate).toSorted(), [
      'INPUT_MISSING inputs/approved-decision.json',
      'INPUT_MISSING inputs/payment.json',
    ]);
    assert.equal(gate.evidence_refs.length, 1);
  });
});
