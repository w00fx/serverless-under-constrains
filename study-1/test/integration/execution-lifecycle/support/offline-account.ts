// The account an offline execution's cleanup acts on (design §10.4, §12.2): its stack and the
// provider version the frozen resource manifest names, tagged with the manifest's ownership tags,
// on the stub discovery surfaces; its source mapping on the fake consumer control; the control
// table of the offline cloud behind the real step-5 barrier release; and every mutation in one
// shared log, so a test can order cleanup against everything else the execution did.

import { ControlTableBarrierRelease } from '../../../../src/cleanup/control-barrier-release.ts';
import { LeakAuditor } from '../../../../src/cleanup/leak-auditor.ts';
import { resourceKey } from '../../../../src/cleanup/resource-names.ts';
import { STACK_RESOURCE_TYPE } from '../../../../src/cleanup/resource-types.ts';
import type { CleanupBindings } from '../../../../src/execution-lifecycle/execution-ports.ts';
import type { DurableItemStore } from '../../../../src/durable-store/item-store-port.ts';
import type { UtcMillis } from '../../../../src/record-contract/primitives.ts';
import type { ResourceManifest } from '../../../../src/record-contract/records/group-a/resource_manifest.ts';
import { discovered, tagged } from '../../../support/cleanup/cleanup-fixtures.ts';
import { FakeConsumerControl } from '../../../support/cleanup/fake-consumer-control.ts';
import { FakeDlqMessages } from '../../../support/cleanup/fake-dlq-messages.ts';
import { FakeDurableExecutions } from '../../../support/cleanup/fake-durable-executions.ts';
import { FakeStackApi } from '../../../support/cleanup/fake-stack-api.ts';
import { RecordingResourceDeleter } from '../../../support/cleanup/recording-resource-deleter.ts';
import { StubDiscoverySurfaces } from '../../../support/cleanup/stub-discovery-surfaces.ts';
import { RecordingMutationLog } from '../../../support/kernel/recording-mutation-log.ts';
import type { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';
import { SOURCE_MAPPING_ID } from './execution-fixtures.ts';

/** When the offline stack's resources were created: after the execution manifest froze. */
const CREATED_AT = '2026-10-05T12:01:00.000Z' as UtcMillis;

/** The fakes of one offline account. */
export interface OfflineAccount {
  readonly log: RecordingMutationLog;
  readonly surfaces: StubDiscoverySurfaces;
  readonly executions: FakeDurableExecutions;
  readonly stack: FakeStackApi;
  readonly consumers: FakeConsumerControl;
  readonly dlq: FakeDlqMessages;
  readonly deleter: RecordingResourceDeleter;
}

/**
 * The account holding what `manifest` deployed (a stack only when it recorded one).
 *
 * @example
 * const account = offlineAccount(resourceManifest);
 * const bindings = cleanupBindings(account, cloud.store, cloud.time);
 */
export function offlineAccount(manifest: ResourceManifest, log = new RecordingMutationLog()): OfflineAccount {
  const surfaces = new StubDiscoverySurfaces();
  const tags = tagged(manifest.ownership_tags);
  const stackId =
    manifest.stack_id ?? `arn:aws:cloudformation:us-east-1:012345678901:stack/${manifest.stack_name}/none`;
  const members = manifest.resources.flatMap((entry) =>
    entry.physical_id === undefined ? [] : [{ resource_type: entry.resource_type, identifier: entry.physical_id }],
  );
  if (manifest.stack_id !== undefined) {
    surfaces.place(
      discovered(STACK_RESOURCE_TYPE, stackId, 'stack', { tags, created_at: CREATED_AT }),
      ...members.map((member) =>
        discovered(member.resource_type, member.identifier, 'stack_resources', {
          tags,
          created_at: CREATED_AT,
          managed_by_stack_id: stackId,
        }),
      ),
    );
  }
  const executions = new FakeDurableExecutions(surfaces, log, stackId);
  const consumers = new FakeConsumerControl(log);
  consumers.add(SOURCE_MAPPING_ID, 1);
  return {
    log,
    surfaces,
    executions,
    stack: new FakeStackApi(surfaces, executions, log, {
      stackId,
      stackName: manifest.stack_name,
      memberKeys: members.map((member) => resourceKey(member)),
      exists: manifest.stack_id !== undefined,
    }),
    consumers,
    dlq: new FakeDlqMessages(log),
    deleter: new RecordingResourceDeleter(surfaces, log),
  };
}

/**
 * The cleanup ports the composition root would bind, over the account and the control table.
 *
 * @example
 * new ExecutionRunner(admitted, { ...deps, cleanup: cleanupBindings(account, cloud.store, cloud.time) });
 */
export function cleanupBindings(
  account: OfflineAccount,
  store: DurableItemStore,
  time: VirtualTimeScheduler,
): CleanupBindings {
  return {
    consumers: account.consumers,
    barriers: new ControlTableBarrierRelease(store),
    durableExecutions: account.executions,
    dlq: account.dlq,
    stacks: account.stack,
    surfaces: account.surfaces,
    deleter: account.deleter,
    sleeper: time,
    auditor: new LeakAuditor({ surfaces: account.surfaces, clock: time, monotonic: time, sleeper: time }),
  };
}
