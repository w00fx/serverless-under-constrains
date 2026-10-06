// The offline cloud's trial executor with a slow evidence root (`LatentPackageStorage`): the same
// store, queues, publisher, warm-up and telemetry as `OfflineCloud.executor`, but every evidence
// file a trial creates takes `latencyMs` of virtual time, so a trial's freeze spans an interval the
// active-time deadline can fall into (AC-RUA-049, the deadline between trials).

import { createRecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import { TrialExecutor } from '../../../../src/trial-execution/trial-executor.ts';
import { SequentialUuidSource } from '../../../support/kernel/sequential-uuid-source.ts';
import type { OfflineCloud } from '../../../support/offline-cloud/offline-cloud.ts';
import { LatentPackageStorage } from '../fakes/latent-package-storage.ts';

/**
 * A trial executor over `cloud` whose evidence writes each wait `latencyMs`.
 *
 * @example
 * const world = await RunnerWorld.create({ deps: (w) => ({ trials: latentTrialExecutor(w.cloud, 5_000) }) });
 */
export function latentTrialExecutor(cloud: OfflineCloud, latencyMs: number): TrialExecutor {
  const storage = new LatentPackageStorage(cloud.storage, cloud.time, latencyMs);
  return new TrialExecutor({
    store: cloud.store,
    queues: cloud.counters,
    dlq: cloud.dlqReceiver,
    durable: cloud.durable,
    telemetry: cloud.telemetry,
    publisher: cloud.publisher,
    warmup: cloud.warmup,
    files: storage,
    runner_journal: storage,
    clock: cloud.time,
    sleeper: cloud.time,
    ids: new SequentialUuidSource('78787878'),
    validator: createRecordValidator(),
    log: (line): void => {
      cloud.logs.push(line);
    },
  });
}
