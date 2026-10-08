// Execution-level evidence (D-10, addendum §2.2, A-09, A-13): the canary, warm-up and unattributed
// provider partitions and the execution configuration, all supplementary.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  collectExecutionEvidence,
  EXECUTION_JOURNAL_PARTITIONS,
} from '../../../src/evidence-collection/readiness-collection.ts';
import { runProviderExecutionConfiguration } from '../../contract/record-contract/group-a/support/manifest-examples.ts';
import { DIGESTS } from '../../contract/record-contract/group-a/support/sample-values.ts';
import {
  EXECUTION,
  journalItem,
  linesOfBytes,
  recordOfBytes,
  RUN_ID,
} from '../../support/evidence-collection/collection-fixtures.ts';
import { storeHarness } from '../../support/durable-store/item-store-fixtures.ts';

describe('collectExecutionEvidence', () => {
  it('exports each execution-level partition and the configuration as supplementary files', async () => {
    const { store } = storeHarness();
    store.seed(
      'caller_journal',
      journalItem(`${RUN_ID}#canary`, 'runner', 1, { record_type: 'caller_timeout_recorded' }),
    );
    store.seed(
      'experiment_journal',
      journalItem(`${RUN_ID}#canary`, 'treatment_controller', 1, { record_type: 'controller_canary_acknowledged' }),
    );
    store.seed(
      'experiment_journal',
      journalItem(`${RUN_ID}#warmup`, 'refund_provider', 1, { record_type: 'provider_warmup_completed' }),
    );
    store.seed(
      'experiment_journal',
      journalItem(`${RUN_ID}#provider`, 'refund_provider', 1, { record_type: 'provider_call_rejected' }),
    );
    const configuration = JSON.parse(JSON.stringify(runProviderExecutionConfiguration())) as Record<string, never>;
    store.seed('control', { ...configuration, pk: `${RUN_ID}#execution`, sk: 'config' });
    const evidence = await collectExecutionEvidence(store, EXECUTION, DIGESTS.executionManifest);
    assert.deepEqual(evidence.failures, []);
    assert.deepEqual(
      evidence.files.map((file) => [file.key, file.role]),
      [
        ['canaryCallerJournal', 'supplementary'],
        ['canaryControllerJournal', 'supplementary'],
        ['warmupProviderJournal', 'supplementary'],
        ['executionProviderJournal', 'supplementary'],
        ['executionConfiguration', 'supplementary'],
      ],
    );
    assert.deepEqual(
      evidence.files.slice(0, 4).map((file) => (linesOfBytes(file.bytes)[0] as Record<string, unknown>)['record_type']),
      [
        'caller_timeout_recorded',
        'controller_canary_acknowledged',
        'provider_warmup_completed',
        'provider_call_rejected',
      ],
    );
    assert.deepEqual(recordOfBytes(evidence.files[4]?.bytes ?? new Uint8Array()), configuration);
  });

  it('routes each partition to its one source and fails closed on anything else', async () => {
    assert.deepEqual(
      EXECUTION_JOURNAL_PARTITIONS.map((partition) => [partition.kind, partition.table, partition.route.sources]),
      [
        ['canary', 'caller_journal', ['runner']],
        ['canary', 'experiment_journal', ['treatment_controller']],
        ['warmup', 'experiment_journal', ['refund_provider']],
        ['provider', 'experiment_journal', ['refund_provider']],
      ],
    );
    const { store } = storeHarness();
    store.seed('experiment_journal', journalItem(`${RUN_ID}#warmup`, 'treatment_controller', 1, {}));
    store.scriptReadFault('InternalServerError', { operation: 'queryPartitionPage', table: 'caller_journal' });
    const evidence = await collectExecutionEvidence(store, EXECUTION, DIGESTS.executionManifest);
    assert.deepEqual(
      evidence.files.map((file) => file.key),
      ['canaryControllerJournal', 'executionProviderJournal'],
    );
    assert.deepEqual(
      evidence.failures.map((failure) => failure.code),
      ['PARTITION_READ_FAILED', 'JOURNAL_ITEM_UNROUTABLE', 'STATE_ITEM_ABSENT'],
    );
  });
});
