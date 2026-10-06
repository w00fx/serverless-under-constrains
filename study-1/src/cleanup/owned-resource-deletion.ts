// Step 9 (BR-RUA-048 "deletes run-owned stacks and remaining resources", BR-RUA-050; design
// §10.4): delete the recorded stack by its id and wait for the outcome, then sweep every surface
// and delete each remaining resource cleanup may delete itself.
//
// Per remaining resource (one decision across all surfaces, `judgeOwnership`):
// - baseline: `EXCLUDED_BASELINE`, never touched;
// - ambiguous: `SKIPPED_AMBIGUOUS`, never deleted, reported with its reasons;
// - owned by manifest and tags, or by the partial-manifest rule: deleted directly, and an owned
//   resource already gone is `ALREADY_ABSENT`, a successful deletion (AC-RUA-011);
// - owned only through the stack boundary and still present after the stack is gone:
//   `DELETE_FAILED`, because BR-RUA-050 lets cleanup delete it only by deleting the stack.
// A resource an earlier run failed to delete and that no surface observes any more (for example
// the stack removed it on a retry) is recorded `ALREADY_ABSENT`, so a re-run's result shows the
// resource gone rather than the stale failure (AC-RUA-011 "cleanup runs one or more times").

import { boundedJsonText } from '../record-contract/json-value.ts';
import type { Sleeper, StructuredReason } from '../record-contract/primitives.ts';
import type { CleanupResource } from '../record-contract/records/group-c/cleanup_result.ts';
import type { DiscoverySurfaces } from './discovery.ts';
import type { ResourceDeleter, StackApi, StackRead } from './cleanup-ports.ts';
import type { OwnershipContext } from './ownership-context.ts';
import type { JudgedResource } from './ownership-judgement.ts';
import { judgeOwnership } from './ownership-judgement.ts';
import { isDirectlyDeletable } from './ownership.ts';
import { resourceKey } from './resource-names.ts';
import { STACK_RESOURCE_TYPE } from './resource-types.ts';
import type { ItemRecorder, StepOutcome } from './step-recording.ts';
import { outcomeFromFailures } from './step-recording.ts';
import { sweepSurfaces } from './surface-sweep.ts';

/** Delay between stack reads while the stack deletes. */
export const STACK_DELETE_POLL_INTERVAL_MS = 15_000;
/** Reads before the deletion is reported failed: one hour, the RK-10 worst case of a blocked delete. */
export const STACK_DELETE_MAX_POLLS = 240;
const DELETE_COMPLETE = 'DELETE_COMPLETE';
const DELETE_FAILED = 'DELETE_FAILED';

export interface DeletionPorts {
  readonly stacks: StackApi;
  readonly surfaces: DiscoverySurfaces;
  readonly deleter: ResourceDeleter;
  readonly sleeper: Sleeper;
}

type StackDeletion =
  | { readonly action: 'DELETED' | 'ALREADY_ABSENT' }
  | { readonly action: 'DELETE_FAILED'; readonly reason: StructuredReason };

/**
 * Step 9: deletes the recorded stack, then every remaining resource cleanup may delete itself.
 * `earlierFailures` are the resources an earlier run failed to delete: one no surface observes
 * any more, after every surface answered, is recorded `ALREADY_ABSENT` (AC-RUA-011).
 *
 * @example
 * const outcome = await deleteOwnedResources(context, { stacks, surfaces, deleter, sleeper }, [], record);
 * outcome.status; // 'succeeded' when nothing owned failed to delete and every surface answered
 */
export async function deleteOwnedResources(
  ownership: OwnershipContext,
  ports: DeletionPorts,
  earlierFailures: readonly CleanupResource[],
  record: ItemRecorder,
): Promise<StepOutcome> {
  const failures: StructuredReason[] = [];
  const stackId = ownership.recorded_stack_id;
  if (stackId !== undefined) {
    failures.push(...(await deleteRecordedStack(stackId, ports, record)));
  }
  const sightings = await sweepSurfaces(ports.surfaces);
  failures.push(...sightings.flatMap((sighting) => sighting.reasons));
  const judged = judgeOwnership(
    sightings.flatMap((sighting) => sighting.resources),
    ownership,
  );
  for (const entry of judged.values()) {
    if (!isRecordedStack(entry.resource.resource_type, entry.resource.identifier, stackId)) {
      failures.push(...(await settleRemainingResource(entry, ports.deleter, record)));
    }
  }
  if (sightings.every((sighting) => sighting.query_ok)) {
    await recordVanishedFailures(earlierFailures, judged, stackId, record);
  }
  return outcomeFromFailures(failures);
}

// An earlier DELETE_FAILED that no surface observes any more is gone: a successful deletion.
async function recordVanishedFailures(
  earlierFailures: readonly CleanupResource[],
  judged: ReadonlyMap<string, JudgedResource>,
  stackId: string | undefined,
  record: ItemRecorder,
): Promise<void> {
  for (const earlier of earlierFailures) {
    const { resource_type: type, resource_identifier: identifier } = earlier;
    if (isRecordedStack(type, identifier, stackId) || judged.has(resourceKey({ resource_type: type, identifier }))) {
      continue;
    }
    await record({
      resource_type: type,
      resource_identifier: identifier,
      ownership_basis: earlier.ownership_basis,
      action: 'ALREADY_ABSENT',
    });
  }
}

function isRecordedStack(resourceType: string, identifier: string, stackId: string | undefined): boolean {
  return resourceType === STACK_RESOURCE_TYPE && identifier === stackId;
}

async function deleteRecordedStack(
  stackId: string,
  ports: DeletionPorts,
  record: ItemRecorder,
): Promise<readonly StructuredReason[]> {
  const deletion = await deleteStackAndWait(stackId, ports);
  const named = {
    resource_type: STACK_RESOURCE_TYPE,
    resource_identifier: stackId,
    ownership_basis: 'recorded_stack' as const,
  };
  if (deletion.action === 'DELETE_FAILED') {
    await record({ ...named, action: deletion.action, reasons: [deletion.reason] });
    return [deletion.reason];
  }
  await record({ ...named, action: deletion.action });
  return [];
}

async function deleteStackAndWait(stackId: string, ports: DeletionPorts): Promise<StackDeletion> {
  if (isGone(await ports.stacks.describe(stackId))) {
    return { action: 'ALREADY_ABSENT' };
  }
  const request = await ports.stacks.requestDelete(stackId);
  if (request.kind === 'failed') {
    return { action: 'DELETE_FAILED', reason: request.reason };
  }
  let lastObserved = 'no read';
  for (let poll = 1; poll <= STACK_DELETE_MAX_POLLS; poll += 1) {
    await ports.sleeper.sleep(STACK_DELETE_POLL_INTERVAL_MS);
    const read = await ports.stacks.describe(stackId);
    if (read.kind === 'failed') {
      lastObserved = `an unreadable stack (${read.reason.code})`;
      continue;
    }
    if (read.kind === 'absent' || read.status === DELETE_COMPLETE) {
      return { action: 'DELETED' };
    }
    if (read.status === DELETE_FAILED) {
      return {
        action: 'DELETE_FAILED',
        reason: stackReason('STACK_DELETE_FAILED', stackId, `status ${DELETE_FAILED}`),
      };
    }
    lastObserved = `status ${boundedJsonText(read.status)}`;
  }
  const observed = `${lastObserved} after ${String(STACK_DELETE_MAX_POLLS)} reads`;
  return { action: 'DELETE_FAILED', reason: stackReason('STACK_DELETE_TIMED_OUT', stackId, observed) };
}

function isGone(read: StackRead): boolean {
  return read.kind === 'absent' || (read.kind === 'present' && read.status === DELETE_COMPLETE);
}

function stackReason(code: string, stackId: string, observed: string): StructuredReason {
  return { code, subject: stackId, detail: `stack deletion ended with ${observed}; expected ${DELETE_COMPLETE}` };
}

async function settleRemainingResource(
  { resource, decision }: JudgedResource,
  deleter: ResourceDeleter,
  record: ItemRecorder,
): Promise<readonly StructuredReason[]> {
  const named = { resource_type: resource.resource_type, resource_identifier: resource.identifier };
  if (decision.kind === 'excluded_baseline') {
    await record({ ...named, action: 'EXCLUDED_BASELINE', ownership_basis: 'excluded_baseline' });
    return [];
  }
  if (decision.kind === 'ambiguous') {
    await record({ ...named, action: 'SKIPPED_AMBIGUOUS', ownership_basis: 'ambiguous', reasons: decision.reasons });
    return [];
  }
  const owned = { ...named, ownership_basis: decision.basis };
  if (!isDirectlyDeletable(decision.basis)) {
    const reason: StructuredReason = {
      code: 'STACK_BOUNDARY_RESOURCE_REMAINS',
      subject: resource.identifier,
      detail: `${resource.resource_type} owned only through the recorded stack is still observed on ${resource.surface}; expected the stack deletion to remove it`,
    };
    await record({ ...owned, action: 'DELETE_FAILED', reasons: [reason] });
    return [reason];
  }
  const deletion = await deleter.delete(resource);
  if (deletion.kind === 'failed') {
    await record({ ...owned, action: 'DELETE_FAILED', reasons: [deletion.reason] });
    return [deletion.reason];
  }
  await record({ ...owned, action: deletion.kind === 'deleted' ? 'DELETED' : 'ALREADY_ABSENT' });
  return [];
}
