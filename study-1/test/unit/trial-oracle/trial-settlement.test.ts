// The settlement facts of a trial: the runner's publication and assessment, and the BR-RUA-032
// re-derivation, which runs only on complete samples with a known publication.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readTrialSettlement } from '../../../src/trial-oracle/trial-settlement.ts';
import { builtEvidence } from './support/built-trials.ts';
import { subjectRecord, textMember } from './support/trial-edits.ts';

const CONTROL = { base: 'run-conventional-control' } as const;

describe('readTrialSettlement', () => {
  it('re-derives an established settlement that matches the runner assessment of a settled trial', () => {
    const settlement = readTrialSettlement(builtEvidence(CONTROL));
    const assessed = subjectRecord(CONTROL, 'runner/runner-journal.jsonl', 'settlement_assessed');
    assert.equal(settlement.samples.complete, true);
    assert.equal(settlement.published?.record.record_type, 'trial_message_published');
    assert.equal(settlement.assessed?.record.event_id, assessed['event_id']);
    assert.equal(settlement.derived?.status, 'established');
    assert.equal(settlement.derived.established_at, assessed['established_at']);
    assert.equal(settlement.derived.rechecked_at, assessed['rechecked_at']);
  });

  it('re-derives not established for processing still active at the deadline', () => {
    const settlement = readTrialSettlement(
      builtEvidence({
        ...CONTROL,
        plan: { deliveries: [{ attempts: [{ behavior: 'commit_failed' }] }], processing: 'active_at_deadline' },
      }),
    );
    assert.equal(settlement.derived?.status, 'not_established');
  });

  it('does not re-derive from absent or unreadable samples', () => {
    const absent = readTrialSettlement(
      builtEvidence({
        ...CONTROL,
        operations: [{ op: 'delete_file', path: '$trial/settlement/settlement-samples.jsonl' }],
      }),
    );
    assert.equal(absent.samples.complete, false);
    assert.equal(absent.derived, undefined);
    assert.ok(absent.published !== undefined && absent.assessed !== undefined);
    const unreadable = readTrialSettlement(
      builtEvidence({
        ...CONTROL,
        operations: [{ op: 'truncate', path: '$trial/settlement/settlement-samples.jsonl', length: 10 }],
      }),
    );
    assert.ok(unreadable.samples.ref !== undefined);
    assert.equal(unreadable.samples.complete, false);
    assert.equal(unreadable.derived, undefined);
  });

  it('does not re-derive without the publication instant', () => {
    const published = subjectRecord(CONTROL, 'runner/runner-journal.jsonl', 'trial_message_published');
    const settlement = readTrialSettlement(
      builtEvidence({
        ...CONTROL,
        operations: [
          {
            op: 'remove_record',
            path: 'runner/runner-journal.jsonl',
            select: { event_id: textMember(published, 'event_id') },
          },
          { op: 'resequence', path: 'runner/runner-journal.jsonl' },
        ],
      }),
    );
    assert.equal(settlement.published, undefined);
    assert.equal(settlement.derived, undefined);
    assert.ok(settlement.assessed !== undefined);
  });
});
