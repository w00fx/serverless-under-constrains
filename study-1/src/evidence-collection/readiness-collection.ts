// Execution-level evidence (design §7 `readiness/`, `provider/`; D-10, addendum §2.2, Owner
// amendment A-09). Besides its trials, an execution leaves evidence in partitions no trial owns:
// - the D-10 controller canary: the runner's inserted `caller_timeout_recorded` in the caller
//   journal's `<execution_id>#canary` partition and the controller's acknowledgement in the
//   experiment journal's partition of the same key;
// - the addendum §2.2 provider warm-up in the experiment journal's `<execution_id>#warmup`;
// - the A-09 `<execution_id>#provider` partition, where the provider journals calls it cannot
//   attribute to a trial;
// - the A-09 execution configuration item (`<execution_id>#execution`/`config`).
// All of them are supplementary: packaged and indexed, never an input of a monetary rule, gate,
// treatment condition or execution scope (A-13, decision 56).

import type { ExecutionIdentity, Sha256Hex } from '../record-contract/primitives.ts';
import { executionPartitionKey } from './capture-scope.ts';
import type { ExecutionPartitionKind } from './capture-scope.ts';
import type { CollectorStoreReader } from './collected-records.ts';
import { keepRead } from './collection-buffer.ts';
import type { CollectionBuffer } from './collection-buffer.ts';
import { exportJournals } from './journal-export.ts';
import type { JournalExportPlan, JournalRoute } from './journal-export.ts';
import { captureExecutionConfiguration } from './state-capture.ts';

interface ReadinessPartition {
  readonly kind: ExecutionPartitionKind;
  readonly table: JournalExportPlan['table'];
  readonly route: JournalRoute;
}

/** Each execution-level journal export: partition, table and the one source it holds (§9.3). */
export const EXECUTION_JOURNAL_PARTITIONS: readonly ReadinessPartition[] = [
  { kind: 'canary', table: 'caller_journal', route: { file: 'canaryCallerJournal', sources: ['runner'] } },
  {
    kind: 'canary',
    table: 'experiment_journal',
    route: { file: 'canaryControllerJournal', sources: ['treatment_controller'] },
  },
  {
    kind: 'warmup',
    table: 'experiment_journal',
    route: { file: 'warmupProviderJournal', sources: ['refund_provider'] },
  },
  {
    kind: 'provider',
    table: 'experiment_journal',
    route: { file: 'executionProviderJournal', sources: ['refund_provider'] },
  },
];

/**
 * Collects the execution-level journals and configuration as supplementary files.
 *
 * @example
 * const evidence = await collectExecutionEvidence(store, execution, manifestSha256);
 * evidence.files.every((file) => file.role === 'supplementary'); // true
 */
export async function collectExecutionEvidence(
  store: CollectorStoreReader,
  execution: ExecutionIdentity,
  executionManifestSha256: Sha256Hex,
): Promise<CollectionBuffer> {
  const buffer: CollectionBuffer = { files: [], failures: [] };
  for (const partition of EXECUTION_JOURNAL_PARTITIONS) {
    const exported = await exportJournals(store, {
      table: partition.table,
      partition_key: executionPartitionKey(execution, executionManifestSha256, partition.kind),
      routes: [partition.route],
    });
    if (!exported.ok) {
      buffer.failures.push(exported.error);
      continue;
    }
    for (const file of exported.value) {
      buffer.files.push({ key: file.file, role: 'supplementary', bytes: file.bytes });
    }
  }
  keepRead(buffer, 'executionConfiguration', await captureExecutionConfiguration(store, execution), 'supplementary');
  return buffer;
}
