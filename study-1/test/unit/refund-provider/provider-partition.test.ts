// Partition resolution and journal scopes (design §9.3, addendum §2): the probe deployment has
// one fixed partition; a trial deployment takes the partition from the call's own trial_id; the
// warm-up journals in the execution-level `#warmup` partition, and a call that names no
// configured trial in the execution-level `#provider` partition (A-09).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { journalPartitionKey } from '../../../src/event-journal/journal-scope.ts';
import {
  callJournalScope,
  resolveCallPartition,
  unattributedJournalScope,
  warmupJournalScope,
} from '../../../src/refund-provider/provider-partition.ts';
import {
  MANIFEST_SHA,
  PAYMENT_ID,
  PROBE,
  PROBE_ID,
  RUN,
  RUN_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  VALIDATION,
  VALIDATION_ID,
  validCall,
} from '../../support/refund-provider/provider-fixtures.ts';

describe('resolveCallPartition', () => {
  it('uses the fixed probe partition in a transport-probe deployment, whatever the call says', () => {
    assert.deepEqual(resolveCallPartition(PROBE, null), { key: `${PROBE_ID}#probe` });
    assert.deepEqual(resolveCallPartition(PROBE, validCall()), { key: `${PROBE_ID}#probe` });
  });

  it('uses the call trial_id in a run or variant-validation deployment', () => {
    assert.deepEqual(resolveCallPartition(RUN, validCall()), { key: `${RUN_ID}#${TRIAL_ID}`, trial_id: TRIAL_ID });
    assert.deepEqual(resolveCallPartition(VALIDATION, validCall()), {
      key: `${VALIDATION_ID}#${TRIAL_ID}`,
      trial_id: TRIAL_ID,
    });
  });

  it('cannot attribute a trial deployment call without a well-formed trial_id', () => {
    assert.equal(resolveCallPartition(RUN, validCall({ trial_id: TRIAL_ID.toUpperCase() })), undefined);
    assert.equal(resolveCallPartition(RUN, { caller_id: 'conventional' }), undefined);
    assert.equal(resolveCallPartition(RUN, [TRIAL_ID]), undefined);
  });
});

describe('journal scopes', () => {
  it('scopes a trial call to its trial with the frozen manifest digest', () => {
    const scope = callJournalScope(RUN, {
      execution_manifest_sha256: MANIFEST_SHA,
      registered_caller_id: 'conventional',
      scenario: 'CONTROL',
      payment_id: PAYMENT_ID,
      trial: { trial_id: TRIAL_ID, trial_manifest_sha256: TRIAL_MANIFEST_SHA },
    });
    assert.deepEqual(scope, {
      execution: RUN,
      execution_manifest_sha256: MANIFEST_SHA,
      partition: { kind: 'trial', trial_id: TRIAL_ID, trial_manifest_sha256: TRIAL_MANIFEST_SHA },
    });
    assert.equal(journalPartitionKey(scope), `${RUN_ID}#${TRIAL_ID}`);
  });

  it('scopes a probe call to the probe partition', () => {
    const scope = callJournalScope(PROBE, {
      execution_manifest_sha256: MANIFEST_SHA,
      registered_caller_id: 'probe',
      scenario: 'COMMIT_THEN_TIMEOUT',
      payment_id: PAYMENT_ID,
    });
    assert.deepEqual(scope, {
      execution: PROBE,
      execution_manifest_sha256: MANIFEST_SHA,
      partition: { kind: 'probe' },
    });
    assert.equal(journalPartitionKey(scope), `${PROBE_ID}#probe`);
  });

  it('scopes a warm-up to the execution-level warm-up partition', () => {
    const scope = warmupJournalScope(RUN, MANIFEST_SHA);
    assert.deepEqual(scope, { execution: RUN, execution_manifest_sha256: MANIFEST_SHA, partition: { kind: 'warmup' } });
    assert.equal(journalPartitionKey(scope), `${RUN_ID}#warmup`);
  });

  it('scopes an unattributed call to the execution-level provider partition (A-09)', () => {
    const scope = unattributedJournalScope(VALIDATION, MANIFEST_SHA);
    assert.deepEqual(scope, {
      execution: VALIDATION,
      execution_manifest_sha256: MANIFEST_SHA,
      partition: { kind: 'provider' },
    });
    assert.equal(journalPartitionKey(scope), `${VALIDATION_ID}#provider`);
  });
});
