// Phase T8 "collect into a buffer" (design §10.2 T8, §7; BR-RUA-034, BR-RUA-037): every artifact of
// one trial or of the probe, in the design's order, with a failed read producing a reason and no
// file, except the ledger, whose incomplete read is itself evidence (AC-RUA-007).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { collectTrialEvidence } from '../../../src/evidence-collection/trial-collection.ts';
import type { TrialCollectionPlan, TrialCollectionPorts } from '../../../src/evidence-collection/trial-collection.ts';
import type { JsonObject, UtcMillis } from '../../../src/record-contract/primitives.ts';
import {
  probeProviderConfiguration,
  trialProviderConfiguration,
  trialRegistration,
} from '../../contract/record-contract/group-a/support/manifest-examples.ts';
import {
  assertValidRecord,
  collectionClock,
  DURABLE_FUNCTION_ARN,
  journalItem,
  ledgerItem,
  PROBE_PK,
  PROBE_SCOPE,
  recordOfBytes,
  sdkEvent,
  sdkExecution,
  sqsMessage,
  TRIAL_ID,
  TRIAL_PK,
  TRIAL_SCOPE,
} from '../../support/evidence-collection/collection-fixtures.ts';
import { ScriptedDlqReceiver } from '../../support/evidence-collection/scripted-dlq-receiver.ts';
import { ScriptedDurableExecutionReader } from '../../support/evidence-collection/scripted-durable-execution-reader.ts';
import { ScriptedTelemetryProbe } from '../../support/evidence-collection/scripted-telemetry-probe.ts';
import { storeHarness } from '../../support/durable-store/item-store-fixtures.ts';
import type { InMemoryItemStore } from '../../support/durable-store/in-memory-item-store.ts';

const DLQ = { queue_url: 'https://sqs/dlq', queue_name: 'suc1-conventional-dlq.fifo' };
const DURABLE = {
  function_arn: DURABLE_FUNCTION_ARN,
  qualifier: '3',
  started_after: '2026-10-05T12:05:00.000Z' as UtcMillis,
};

const asItem = (record: object, pk: string, sk: string): JsonObject & { pk: string; sk: string } => ({
  ...(JSON.parse(JSON.stringify(record)) as JsonObject),
  pk,
  sk,
});

function seedTrial(store: InMemoryItemStore): void {
  store.seed('ledger', ledgerItem(TRIAL_PK, 1));
  store.seed(
    'caller_journal',
    journalItem(TRIAL_PK, 'conventional_caller', 1, { record_type: 'caller_invocation_started' }),
  );
  store.seed(
    'experiment_journal',
    journalItem(TRIAL_PK, 'refund_provider', 1, { record_type: 'provider_call_received' }),
  );
  store.seed('control', asItem(trialProviderConfiguration(), TRIAL_PK, 'config'));
  store.seed('trial_registry', asItem(trialRegistration(), 'registry#conventional', 'active'));
}

function ports(
  store: InMemoryItemStore,
  dlq = new ScriptedDlqReceiver(),
  durable = new ScriptedDurableExecutionReader(),
): TrialCollectionPorts {
  return {
    store,
    dlq,
    durable,
    telemetry: new ScriptedTelemetryProbe({ logs: ['/aws/lambda/suc1'] }),
    clock: collectionClock(),
  };
}

function fileRecord(files: readonly { readonly key: string; readonly bytes: Uint8Array }[], key: string): JsonObject {
  const file = files.find((candidate) => candidate.key === key);
  assert.ok(file, `file ${key}`);
  return recordOfBytes(file.bytes);
}

describe('collectTrialEvidence', () => {
  it('collects a conventional trial in the T8 order, every record valid', async () => {
    const { store } = storeHarness();
    seedTrial(store);
    const plan: TrialCollectionPlan = { scope: TRIAL_SCOPE, variant: 'conventional', dlq: DLQ };
    const collection = await collectTrialEvidence(ports(store), plan);
    assert.deepEqual(collection.failures, []);
    assert.equal(collection.ledger_complete, true);
    assert.deepEqual(
      collection.files.map((file) => file.key),
      [
        'ledgerSnapshot',
        'callerJournal',
        'providerJournal',
        'controllerJournal',
        'treatmentStateSnapshot',
        'providerTrialConfiguration',
        'trialRegistration',
        'telemetryAvailability',
      ],
    );
    assert.ok(collection.files.every((file) => file.role === 'trial_evidence'));
    for (const key of [
      'ledgerSnapshot',
      'treatmentStateSnapshot',
      'providerTrialConfiguration',
      'trialRegistration',
      'telemetryAvailability',
    ]) {
      assertValidRecord(fileRecord(collection.files, key), key);
    }
    assert.deepEqual(collection.dlq_capture?.correlated_message_ids, []);
    assert.equal(collection.dlq_capture.receive_complete, true);
  });

  it('writes the conditional DLQ snapshot only when the trial message was captured', async () => {
    const { store } = storeHarness();
    seedTrial(store);
    const dlq = new ScriptedDlqReceiver();
    dlq.enqueue(sqsMessage({ id: 'other', group: '00000000-0000-4000-8000-000000000204' }));
    const without = await collectTrialEvidence(ports(store, dlq), {
      scope: TRIAL_SCOPE,
      variant: 'conventional',
      dlq: DLQ,
    });
    assert.equal(
      without.files.some((file) => file.key === 'dlqSnapshot'),
      false,
    );
    assert.deepEqual(without.dlq_capture?.captured_message_ids, ['other']);
    dlq.enqueue(sqsMessage({ id: 'mine', group: TRIAL_ID }));
    const withMessage = await collectTrialEvidence(ports(store, dlq), {
      scope: TRIAL_SCOPE,
      variant: 'conventional',
      dlq: DLQ,
    });
    assert.equal(withMessage.files[1]?.key, 'dlqSnapshot', 'the DLQ capture follows the ledger');
    assertValidRecord(fileRecord(withMessage.files, 'dlqSnapshot'), 'dlq_snapshot');
  });

  it('collects the Durable metadata of a Durable trial', async () => {
    const { store } = storeHarness();
    seedTrial(store);
    store.seed(
      'trial_registry',
      asItem({ ...trialRegistration(), variant_id: 'durable' }, 'registry#durable', 'active'),
    );
    const durable = new ScriptedDurableExecutionReader();
    durable.addExecution(sdkExecution(1, 'SUCCEEDED'), [sdkEvent('ExecutionStarted', 1)]);
    const collection = await collectTrialEvidence(ports(store, new ScriptedDlqReceiver(), durable), {
      scope: TRIAL_SCOPE,
      variant: 'durable',
      dlq: DLQ,
      durable: DURABLE,
    });
    assert.deepEqual(collection.failures, []);
    assert.equal(collection.files.at(-2)?.key, 'durableExecutions');
    assertValidRecord(fileRecord(collection.files, 'durableExecutions'), 'durable_execution_metadata');
  });

  it('collects the probe without queues, registration or Durable metadata', async () => {
    const { store } = storeHarness();
    store.seed('control', asItem(probeProviderConfiguration(), PROBE_PK, 'config'));
    store.seed('control', { pk: PROBE_PK, sk: 'treatment', state: 'RESPONSE_RELEASED', version: 5 });
    const dlq = new ScriptedDlqReceiver();
    const collection = await collectTrialEvidence(ports(store, dlq), {
      scope: PROBE_SCOPE,
      dlq: DLQ,
      durable: DURABLE,
    });
    assert.deepEqual(collection.failures, []);
    assert.equal(collection.dlq_capture, undefined);
    assert.equal(dlq.receiveCount(), 0);
    assert.deepEqual(
      collection.files.map((file) => file.key),
      [
        'ledgerSnapshot',
        'callerJournal',
        'providerJournal',
        'controllerJournal',
        'treatmentStateSnapshot',
        'providerTrialConfiguration',
        'telemetryAvailability',
      ],
    );
  });

  it('fails closed: a failed read leaves its artifact out with a reason, the ledger records its own failure', async () => {
    const { store } = storeHarness(1);
    seedTrial(store);
    store.seed('ledger', ledgerItem(TRIAL_PK, 2));
    store.scriptReadFault('InternalServerError', { operation: 'queryPartitionPage', table: 'ledger' });
    store.scriptReadFault('InternalServerError', { operation: 'queryPartitionPage', table: 'caller_journal' });
    store.scriptReadFault('InternalServerError', { operation: 'getConsistent', table: 'control' });
    const dlq = new ScriptedDlqReceiver();
    dlq.scriptFailure('ThrottlingException');
    const durable = new ScriptedDurableExecutionReader();
    durable.scriptFailure('listPage', 'ThrottlingException');
    const collection = await collectTrialEvidence(ports(store, dlq, durable), {
      scope: TRIAL_SCOPE,
      variant: 'durable',
      dlq: DLQ,
      durable: DURABLE,
    });
    assert.equal(collection.ledger_complete, false);
    assert.equal(fileRecord(collection.files, 'ledgerSnapshot')['complete'], false);
    assert.deepEqual(
      collection.files.map((file) => file.key),
      [
        'ledgerSnapshot',
        'providerJournal',
        'controllerJournal',
        'providerTrialConfiguration',
        'durableExecutions',
        'telemetryAvailability',
      ],
    );
    assert.deepEqual(
      collection.failures.map((failure) => failure.code),
      [
        'LEDGER_READ_FAILED',
        'DLQ_RECEIVE_FAILED',
        'PARTITION_READ_FAILED',
        'STATE_READ_FAILED',
        'STATE_ITEM_ABSENT',
        'DURABLE_PAGE_READ_FAILED',
      ],
    );
    assert.equal(fileRecord(collection.files, 'durableExecutions')['list_complete'], false);
  });

  it('reports a record JSON cannot represent instead of writing it (A-05)', async () => {
    const { store } = storeHarness();
    seedTrial(store);
    store.seed('ledger', { ...ledgerItem(TRIAL_PK, 2), amount_minor: JSON.parse('1e400') as number });
    const collection = await collectTrialEvidence(ports(store), {
      scope: TRIAL_SCOPE,
      variant: 'conventional',
      dlq: DLQ,
    });
    assert.equal(
      collection.files.some((file) => file.key === 'ledgerSnapshot'),
      false,
    );
    assert.deepEqual(
      collection.failures.map((failure) => failure.code),
      ['RECORD_NOT_REPRESENTABLE'],
    );
  });
});
