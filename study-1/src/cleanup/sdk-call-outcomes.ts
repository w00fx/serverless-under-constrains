// What one settled SDK call means for cleanup (design §5 principle 5, §10.4): the adapters in
// `aws/` send a request, settle it here and hand the result over, so every decision about a
// failure stays in a mutation-tested module:
// - a "not found" failure is an absent resource, which every port reports as such (a mapping
//   already deleted, a stack gone, a resource already deleted: AC-RUA-011);
// - any other failure is reported with its error name as the reason code, never thrown;
// - output that does not read as expected fails like a call, with the offending member.

import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import type {
  ConsumerDisableRequest,
  ConsumerStateRead,
  DurableStopOutcome,
  ResourceDeletion,
  StackDeleteRequest,
  StackRead,
} from './cleanup-ports.ts';
import type {
  PresenceCheck,
  ResourceTag,
  SurfaceQueryResult,
  TagObservation,
  DiscoveredResource,
} from './discovery.ts';
import type { DlqMessageChange, DlqReceive } from './dlq-message-deletion.ts';
import type { Page, Reading, SdkFailure } from './surface-readings.ts';
import { collectPages, failureReason, isNotFound, sdkFailureOf } from './surface-readings.ts';
import { mappingReading } from './surface-readings-lambda.ts';
import { receivedDlqMessages, STACK_DELETE_COMPLETE, stackReading } from './surface-readings-services.ts';

/** The settled outcome of one SDK call: its output, or how it failed. */
export type SdkCallResult = Result<unknown, SdkFailure>;

/** What a read of one resource found: its reading, that it does not exist, or why it failed. */
export type Described<T> =
  | { readonly kind: 'found'; readonly value: T }
  | { readonly kind: 'gone' }
  | { readonly kind: 'failed'; readonly reason: StructuredReason };

const RUNNING = 'RUNNING';

/**
 * Settles one SDK call: its output, or the name and message of what it threw. Never throws.
 *
 * @example
 * const settled = await settleCleanupCall(() => client.send(new GetRoleCommand({ RoleName: name })));
 */
export async function settleCleanupCall(call: () => Promise<unknown>): Promise<SdkCallResult> {
  try {
    return ok(await call());
  } catch (thrown: unknown) {
    return err(sdkFailureOf(thrown));
  }
}

/**
 * A settled read: `gone` when the service says the resource does not exist, `failed` when the call
 * failed otherwise or its output does not read, `found` with the reading otherwise.
 *
 * @example
 * described(settled, roleReading, roleName, 'a role description'); // { kind: 'found', value: { name, arn } }
 */
export function described<T>(
  call: SdkCallResult,
  read: (output: unknown) => Reading<T>,
  subject: string,
  expected: string,
): Described<T> {
  if (!call.ok) {
    return isNotFound(call.error)
      ? { kind: 'gone' }
      : { kind: 'failed', reason: failureReason(call.error, subject, expected) };
  }
  const reading = read(call.value);
  return reading.ok ? { kind: 'found', value: reading.value } : { kind: 'failed', reason: reading.error };
}

/**
 * Every page of a listing of one resource (its tags, versions or stack resources): `gone` when
 * any page says the resource does not exist.
 *
 * @example
 * await describedPages((cursor) => settleCleanupCall(() => listTags(cursor)), tableTagsPage, arn, 'the table tags');
 */
export async function describedPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<SdkCallResult>,
  readPage: (output: unknown) => Reading<Page<T>>,
  subject: string,
  expected: string,
): Promise<Described<readonly T[]>> {
  // The last page read: a gone page ends the paging with its stand-in reason, never reported.
  const last: { page?: Described<Page<T>> } = {};
  const listing = await collectPages(async (cursor) => {
    const page = described(await fetchPage(cursor), readPage, subject, expected);
    last.page = page;
    return page.kind === 'found' ? ok(page.value) : err(reasonOf(page));
  }, subject);
  if (last.page?.kind === 'gone') {
    return { kind: 'gone' };
  }
  return listing.ok ? { kind: 'found', value: listing.value } : { kind: 'failed', reason: listing.error };
}

/**
 * The items of a listing whose subject may not exist: none when it is gone.
 *
 * @example
 * itemsOrNone({ kind: 'gone' }); // ok([])
 */
export function itemsOrNone<T>(listing: Described<readonly T[]>): Reading<readonly T[]> {
  return listing.kind === 'found' ? ok(listing.value) : nothingFound(listing);
}

/**
 * Nothing sighted: none for a resource that is gone, the failure for one that could not be read.
 *
 * @example
 * nothingFound({ kind: 'failed', reason }); // err(reason)
 */
export function nothingFound(
  outcome: { readonly kind: 'gone' } | { readonly kind: 'failed'; readonly reason: StructuredReason },
): Reading<readonly never[]> {
  return outcome.kind === 'gone' ? ok([]) : err(outcome.reason);
}

/**
 * Reads each item in turn and joins what they sighted; the first failure ends the reading.
 *
 * @example
 * await readingsOfEach(targets.role_names, (name) => roleSightings(iam, name));
 */
export async function readingsOfEach<T, U>(
  items: readonly T[],
  read: (item: T) => Promise<Reading<readonly U[]>>,
): Promise<Reading<readonly U[]>> {
  const joined: U[] = [];
  for (const item of items) {
    const reading = await read(item);
    if (!reading.ok) {
      return reading;
    }
    joined.push(...reading.value);
  }
  return ok(joined);
}

/**
 * The sighting of one described resource with the tags read for it: none when the tag read says
 * the resource is gone, tags unknown when the tag read failed.
 *
 * @example
 * sightingWithTags(sighted, { kind: 'found', value: [] }); // [{ ...sighted, tags: { kind: 'tagged', tags: [] } }]
 */
export function sightingWithTags(
  sighted: Omit<DiscoveredResource, 'tags'>,
  tags: Described<readonly ResourceTag[]>,
): readonly DiscoveredResource[] {
  const observed = observedTags(tags);
  return observed === undefined ? [] : [{ ...sighted, tags: observed }];
}

/**
 * The tag observation of a tag read, or `undefined` when the resource is gone (it is then not
 * sighted at all). A failed tag read leaves ownership unknown, never "untagged".
 *
 * @example
 * observedTags({ kind: 'failed', reason }); // { kind: 'unknown', reason }
 */
export function observedTags(tags: Described<readonly ResourceTag[]>): TagObservation | undefined {
  if (tags.kind === 'gone') {
    return undefined;
  }
  return tags.kind === 'found' ? { kind: 'tagged', tags: tags.value } : { kind: 'unknown', reason: tags.reason };
}

/**
 * The answer of one surface query.
 *
 * @example
 * surfaceAnswer(ok([])); // { ok: true, resources: [] }
 */
export function surfaceAnswer(resources: Reading<readonly DiscoveredResource[]>): SurfaceQueryResult {
  return resources.ok ? { ok: true, resources: resources.value } : { ok: false, reason: resources.error };
}

/**
 * What a native describe says of a resource the tag index listed.
 *
 * @example
 * presenceOf({ kind: 'gone' }); // { kind: 'absent' }
 */
export function presenceOf(resource: Described<boolean>): PresenceCheck {
  if (resource.kind === 'failed') {
    return resource;
  }
  return resource.kind === 'found' && resource.value ? { kind: 'present' } : { kind: 'absent' };
}

/**
 * `UpdateEventSourceMapping(Enabled=false)`: requested, or the mapping is already gone.
 *
 * @example
 * disableRequestOutcome(ok({}), uuid); // { kind: 'requested' }
 */
export function disableRequestOutcome(call: SdkCallResult, mappingId: string): ConsumerDisableRequest {
  const request = described(call, ok, mappingId, 'the mapping disable to be accepted');
  return request.kind === 'found' ? { kind: 'requested' } : absentOrFailed(request);
}

/**
 * `GetEventSourceMapping`: the mapping's `State`, or that it is gone.
 *
 * @example
 * consumerStateOutcome(ok({ UUID: uuid, State: 'Disabled' }), uuid); // { kind: 'state', state: 'Disabled' }
 */
export function consumerStateOutcome(call: SdkCallResult, mappingId: string): ConsumerStateRead {
  const mapping = described(call, mappingReading, mappingId, 'the mapping state');
  return mapping.kind === 'found' ? { kind: 'state', state: mapping.value.state } : absentOrFailed(mapping);
}

/**
 * `DescribeStacks` of the recorded stack: absent when it does not exist, is not listed or is
 * `DELETE_COMPLETE`.
 *
 * @example
 * stackReadOutcome(err({ name: 'ValidationError', message: `Stack with id ${id} does not exist` }), id); // { kind: 'absent' }
 */
export function stackReadOutcome(call: SdkCallResult, stackId: string): StackRead {
  const stack = described(call, stackReading, stackId, 'the stack description');
  if (stack.kind !== 'found') {
    return absentOrFailed(stack);
  }
  const status = stack.value?.status;
  return status === undefined || status === STACK_DELETE_COMPLETE ? { kind: 'absent' } : { kind: 'present', status };
}

/**
 * `DeleteStack`: requested (CloudFormation accepts a delete of a stack already gone).
 *
 * @example
 * stackDeleteOutcome(ok({}), id); // { kind: 'requested' }
 */
export function stackDeleteOutcome(call: SdkCallResult, stackId: string): StackDeleteRequest {
  return call.ok
    ? { kind: 'requested' }
    : { kind: 'failed', reason: failureReason(call.error, stackId, 'the stack deletion to be accepted') };
}

/**
 * A direct delete: deleted, already absent (AC-RUA-011) or failed (`DeleteConflict` included).
 *
 * @example
 * deletionOutcome(err({ name: 'ResourceNotFoundException', message: '' }), name); // { kind: 'already_absent' }
 */
export function deletionOutcome(call: SdkCallResult, subject: string): ResourceDeletion {
  const deletion = described(call, ok, subject, 'the resource to be deleted');
  if (deletion.kind === 'found') {
    return { kind: 'deleted' };
  }
  return deletion.kind === 'gone' ? { kind: 'already_absent' } : deletion;
}

/**
 * Whether a failed `StopDurableExecution` needs the execution's status to be read: a stop the
 * service refused for an execution that is not found needs none.
 *
 * @example
 * stopNeedsStatusRead(err({ name: 'InvalidParameterValueException', message: '' })); // true
 */
export function stopNeedsStatusRead(stop: SdkCallResult): boolean {
  return !stop.ok && !isNotFound(stop.error);
}

/**
 * `StopDurableExecution`: stopped, or not running when the execution is gone or, after a refused
 * stop, its status is no longer `RUNNING` (it ended between the listing and the stop). The error
 * a stop of an ended execution answers is not documented, so the status read decides.
 *
 * @example
 * durableStopOutcome(refused, { kind: 'found', value: 'SUCCEEDED' }, arn); // { kind: 'not_running' }
 */
export function durableStopOutcome(
  stop: SdkCallResult,
  status: Described<string> | undefined,
  executionArn: string,
): DurableStopOutcome {
  if (stop.ok) {
    return { kind: 'stopped' };
  }
  const ended = status?.kind === 'gone' || (status?.kind === 'found' && status.value !== RUNNING);
  if (isNotFound(stop.error) || ended) {
    return { kind: 'not_running' };
  }
  return { kind: 'failed', reason: failureReason(stop.error, executionArn, 'the running execution to stop') };
}

/**
 * One `ReceiveMessage` of a DLQ sweep.
 *
 * @example
 * dlqReceiveOutcome(ok({}), url); // { kind: 'messages', messages: [] }
 */
export function dlqReceiveOutcome(call: SdkCallResult, queueUrl: string): DlqReceive {
  const received = described(call, receivedDlqMessages, queueUrl, 'a receive of the dead-letter queue');
  if (received.kind === 'found') {
    return { kind: 'messages', messages: received.value };
  }
  return received.kind === 'gone' ? { kind: 'queue_absent' } : received;
}

/**
 * One `DeleteMessage` or `ChangeMessageVisibility` of a DLQ sweep.
 *
 * @example
 * dlqChangeOutcome(ok({}), url, 'the message to be deleted'); // { kind: 'done' }
 */
export function dlqChangeOutcome(call: SdkCallResult, queueUrl: string, expected: string): DlqMessageChange {
  return call.ok ? { kind: 'done' } : { kind: 'failed', reason: failureReason(call.error, queueUrl, expected) };
}

function absentOrFailed(
  outcome: { readonly kind: 'gone' } | { readonly kind: 'failed'; readonly reason: StructuredReason },
): { readonly kind: 'absent' } | { readonly kind: 'failed'; readonly reason: StructuredReason } {
  return outcome.kind === 'gone' ? { kind: 'absent' } : outcome;
}

function reasonOf(
  outcome: { readonly kind: 'gone' } | { readonly kind: 'failed'; readonly reason: StructuredReason },
): StructuredReason {
  // A gone page stops the paging; its reason is never reported, because the listing is `gone`.
  return outcome.kind === 'failed'
    ? outcome.reason
    : { code: 'RESOURCE_GONE', subject: 'paging', detail: 'the listed resource does not exist; expected none' };
}
