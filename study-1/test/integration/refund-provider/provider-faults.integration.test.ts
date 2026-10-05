// Operational faults of the composed provider (design §9.9, D-20): a call it cannot attribute,
// configure, read, commit or record ends with a thrown ProviderFault (a Lambda function error),
// never with a business response, and the fault's phase says whether a commit may exist.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  armedTreatmentItem,
  field,
  ledgerItems,
  paymentItem,
  providerEventTypes,
  providerHarness,
  seedRunTrial,
  treatmentItem,
  TRIAL_PK,
  trialConfigItem,
  validCall,
  withoutProperty,
} from '../../unit/refund-provider/support/provider-fixtures.ts';
import { expectProviderFault } from './support/fault-assertions.ts';
import { failJournalWritesAfter } from './support/provider-run.ts';

const AMBIGUOUS = { kind: 'ambiguous', code: 'TimeoutError', applied: false } as const;

describe('RefundProvider faults', () => {
  it('cannot attribute a call without a trial partition, and journals nothing', async () => {
    const harness = providerHarness();
    seedRunTrial(harness, 'CONTROL');
    const fault = await expectProviderFault(
      harness.provider.handle(withoutProperty(validCall(), 'trial_id')),
      'UNATTRIBUTABLE_CALL',
      'before_commit',
    );
    assert.match(fault.message, /\(trial_id undefined\)/u);
    assert.ok(fault.providerCallId !== undefined);
    const scalar = await expectProviderFault(harness.provider.handle(42), 'UNATTRIBUTABLE_CALL', 'before_commit');
    assert.match(scalar.message, /\(trial_id 42\)/u);
    assert.deepEqual(harness.store.itemsIn('experiment_journal'), []);
  });

  it('faults CONFIGURATION_MISSING when the partition has no frozen configuration', async () => {
    const harness = providerHarness();
    const fault = await expectProviderFault(
      harness.provider.handle(validCall()),
      'CONFIGURATION_MISSING',
      'before_commit',
    );
    assert.match(fault.message, new RegExp(`no provider configuration in partition ${TRIAL_PK}`, 'u'));
  });

  it('faults STATE_UNREADABLE on a failed or undecodable control read', async () => {
    const failedRead = providerHarness();
    seedRunTrial(failedRead, 'CONTROL');
    failedRead.store.scriptReadFault('InternalServerError', { table: 'control' });
    const fault = await expectProviderFault(
      failedRead.provider.handle(validCall()),
      'STATE_UNREADABLE',
      'before_commit',
    );
    assert.match(fault.message, /control read .*\/config failed: InternalServerError; expected a consistent read/u);

    const badPayment = providerHarness();
    badPayment.store.seed('control', trialConfigItem('CONTROL'));
    badPayment.store.seed('control', paymentItem(TRIAL_PK, { currency: 986 }));
    await expectProviderFault(badPayment.provider.handle(validCall()), 'STATE_UNREADABLE', 'before_commit');

    const badTreatment = providerHarness();
    seedRunTrial(badTreatment, 'CONTROL');
    badTreatment.store.seed('control', { ...armedTreatmentItem(TRIAL_PK), version: 0 });
    await expectProviderFault(badTreatment.provider.handle(validCall()), 'STATE_UNREADABLE', 'before_commit');
    assert.deepEqual(badTreatment.store.itemsIn('experiment_journal'), []);
  });

  it('faults JOURNAL_STOPPED before any decision when the receipt cannot be recorded', async () => {
    const harness = providerHarness();
    seedRunTrial(harness, 'COMMIT_THEN_TIMEOUT');
    harness.store.scriptWriteFault(AMBIGUOUS, { operation: 'write' });
    const fault = await expectProviderFault(harness.provider.handle(validCall()), 'JOURNAL_STOPPED', 'before_commit');
    assert.match(fault.message, /provider_call_received not recorded \(AMBIGUOUS_APPEND\)/u);
    assert.deepEqual(ledgerItems(harness, TRIAL_PK), []);
  });

  it('faults JOURNAL_STOPPED when a rejection cannot be recorded', async () => {
    const harness = providerHarness();
    seedRunTrial(harness, 'CONTROL');
    failJournalWritesAfter(harness, 'provider_call_received', AMBIGUOUS);
    await expectProviderFault(
      harness.provider.handle(validCall({ currency: 'USD' })),
      'JOURNAL_STOPPED',
      'before_commit',
    );
    assert.deepEqual(providerEventTypes(harness, TRIAL_PK), ['provider_call_received']);
  });

  it('commits nothing when the acceptance cannot be recorded', async () => {
    const harness = providerHarness();
    seedRunTrial(harness, 'COMMIT_THEN_TIMEOUT');
    failJournalWritesAfter(
      harness,
      'provider_call_received',
      { kind: 'definitive_failure', code: 'InternalServerError' },
      3,
    );
    const fault = await expectProviderFault(harness.provider.handle(validCall()), 'JOURNAL_STOPPED', 'before_commit');
    assert.match(fault.message, /provider_call_accepted not recorded \(DEFINITIVE_RETRIES_EXHAUSTED\)/u);
    assert.deepEqual(ledgerItems(harness, TRIAL_PK), []);
    assert.deepEqual(treatmentItem(harness, TRIAL_PK), armedTreatmentItem(TRIAL_PK));
  });

  it('records a definitive commit failure and faults COMMIT_FAILED with the treatment still armed', async () => {
    const harness = providerHarness();
    seedRunTrial(harness, 'COMMIT_THEN_TIMEOUT');
    harness.store.scriptWriteFault(
      { kind: 'definitive_failure', code: 'InternalServerError' },
      { operation: 'transact' },
    );
    await expectProviderFault(harness.provider.handle(validCall()), 'COMMIT_FAILED', 'before_commit');
    assert.deepEqual(providerEventTypes(harness, TRIAL_PK), [
      'provider_call_received',
      'provider_call_accepted',
      'provider_commit_failed',
    ]);
    assert.deepEqual(treatmentItem(harness, TRIAL_PK), armedTreatmentItem(TRIAL_PK));
  });

  it('faults COMMIT_AMBIGUOUS when the commit outcome is unknown', async () => {
    const harness = providerHarness();
    seedRunTrial(harness, 'CONTROL');
    harness.store.scriptWriteFault(
      { kind: 'ambiguous', code: 'TimeoutError', applied: true },
      { operation: 'transact' },
    );
    await expectProviderFault(harness.provider.handle(validCall()), 'COMMIT_AMBIGUOUS', 'commit_unknown');
    assert.equal(ledgerItems(harness, TRIAL_PK).length, 1);
  });

  it('faults after the commit when the untargeted response cannot be recorded', async () => {
    const harness = providerHarness();
    seedRunTrial(harness, 'CONTROL');
    failJournalWritesAfter(harness, 'provider_commit_confirmed', AMBIGUOUS);
    const fault = await expectProviderFault(harness.provider.handle(validCall()), 'JOURNAL_STOPPED', 'after_commit');
    assert.match(fault.message, /provider_response_returned not recorded/u);
    assert.equal(field(ledgerItems(harness, TRIAL_PK)[0], 'status'), 'SUCCEEDED');
  });
});
