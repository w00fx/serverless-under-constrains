// Operational faults of the composed provider (design §9.9, D-20): a call it cannot journal,
// read, commit or record ends with a thrown ProviderFault (a Lambda function error), never with
// a business response, and the fault's phase says whether a commit may exist. A call that names
// no configured trial is journaled in `<execution_id>#provider` (A-09); it faults only in the
// documented residual, before the runner wrote the execution configuration.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  armedTreatmentItem,
  executionConfigItem,
  field,
  ledgerItems,
  paymentItem,
  providerEventTypes,
  providerHarness,
  OTHER_RUN_ID,
  RUN,
  RUN_ID,
  seedExecutionConfiguration,
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
const NOT_JOURNALED = `; no execution configuration at control ${RUN_ID}#execution/config, so the rejection cannot be journaled (A-09)`;

describe('RefundProvider faults', () => {
  it('without the execution configuration, cannot journal an unattributable call (A-09 residual)', async () => {
    const harness = providerHarness();
    seedRunTrial(harness, 'CONTROL');
    const fault = await expectProviderFault(
      harness.provider.handle(withoutProperty(validCall(), 'trial_id')),
      'UNATTRIBUTABLE_CALL',
      'before_commit',
    );
    assert.equal(
      fault.message,
      `UNATTRIBUTABLE_CALL: call names no trial partition (trial_id absent); expected a call object with a lowercase UUIDv4 trial_id${NOT_JOURNALED}`,
    );
    assert.ok(fault.providerCallId !== undefined);
    const scalar = await expectProviderFault(harness.provider.handle(42), 'UNATTRIBUTABLE_CALL', 'before_commit');
    assert.match(scalar.message, /\(payload number 42\)/u);
    assert.deepEqual(harness.store.itemsIn('experiment_journal'), []);
  });

  it('without the execution configuration, faults CONFIGURATION_MISSING for an unconfigured trial', async () => {
    const harness = providerHarness();
    const fault = await expectProviderFault(
      harness.provider.handle(validCall()),
      'CONFIGURATION_MISSING',
      'before_commit',
    );
    assert.equal(
      fault.message,
      `CONFIGURATION_MISSING: no provider configuration in partition ${TRIAL_PK}; expected the frozen config item${NOT_JOURNALED}`,
    );
    assert.deepEqual(harness.store.itemsIn('experiment_journal'), []);
  });

  it('faults STATE_UNREADABLE on a failed or undecodable execution configuration read (A-09)', async () => {
    const failedRead = providerHarness();
    seedExecutionConfiguration(failedRead);
    failedRead.store.scriptReadFault('InternalServerError', { table: 'control' });
    const fault = await expectProviderFault(failedRead.provider.handle(42), 'STATE_UNREADABLE', 'before_commit');
    assert.equal(
      fault.message,
      `STATE_UNREADABLE: control read ${RUN_ID}#execution/config failed: InternalServerError; expected a consistent read of the execution configuration`,
    );

    const otherExecution = providerHarness();
    otherExecution.store.seed('control', executionConfigItem(RUN, { run_id: OTHER_RUN_ID }));
    await expectProviderFault(otherExecution.provider.handle(42), 'STATE_UNREADABLE', 'before_commit');
    assert.deepEqual(otherExecution.store.itemsIn('experiment_journal'), []);
  });

  it('faults JOURNAL_STOPPED when an unattributed rejection cannot be recorded (A-09)', async () => {
    const harness = providerHarness();
    seedExecutionConfiguration(harness);
    harness.store.scriptWriteFault(AMBIGUOUS, { operation: 'write' });
    const fault = await expectProviderFault(harness.provider.handle(42), 'JOURNAL_STOPPED', 'before_commit');
    assert.match(fault.message, /^JOURNAL_STOPPED: provider_call_rejected not recorded \(/u);
    assert.deepEqual(ledgerItems(harness, TRIAL_PK), []);
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
