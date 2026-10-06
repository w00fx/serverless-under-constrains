// Pure readings of the AWS SDK output that cleanup's adapters receive (design §5 principle 5,
// §9.14; Owner amendment A-05). The adapters in `aws/` send one request each and hand the output
// here, so every decision about what a response means stays in a mutation-tested module. This
// module holds what every service shares:
// - which failure means "not found" (an absent resource is a successful deletion, AC-RUA-011);
// - how a page continues, with a bound and a guard against a cursor that repeats;
// - how tags are read, and the total readers of untrusted members.
// The per-service readings live in `surface-readings-lambda.ts` and `surface-readings-services.ts`.
// SDK output is untrusted (a broken or hostile endpoint): only own members are read, nothing is
// walked recursively, a non-finite or out-of-range number is malformed, and a malformed member
// fails the reading with the offending value and the expected shape, never a throw.

import { boundedJsonText, boundedText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import type { LeakAuditSurface } from '../record-contract/records/group-c/vocabulary.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { DiscoveredResource, ResourceTag, TagObservation } from './discovery.ts';
import { upperSnakeCode } from './reason-conformance.ts';

/** How one SDK call failed: the error's name (`ResourceNotFoundException`) and message. */
export interface SdkFailure {
  readonly name: string;
  readonly message: string;
}

/** A reading of SDK output, or why the output is malformed. */
export type Reading<T> = Result<T, StructuredReason>;

/** One page of a listing: its items and the cursor of the next page, if any. */
export interface Page<T> {
  readonly items: readonly T[];
  readonly cursor?: string;
}

/** Pages one listing may take before it is refused as unbounded. */
export const MAX_PAGES = 100;
export const MALFORMED_OUTPUT = 'SDK_OUTPUT_MALFORMED';

const NOT_FOUND_NAMES: ReadonlySet<string> = new Set([
  'ResourceNotFoundException',
  'QueueDoesNotExist',
  'NoSuchEntityException',
]);
const UNNAMED_FAILURE = 'UnnamedSdkFailure';
const MAX_FAILURE_NAME_LENGTH = 64;
// The first and last instants a UTC-millis timestamp can spell (years 0000-9999).
const MIN_INSTANT_MS = Date.parse('0000-01-01T00:00:00.000Z');
const MAX_INSTANT_MS = Date.parse('9999-12-31T23:59:59.999Z');

/**
 * The name and message of a thrown SDK error; total over any thrown value.
 *
 * @example
 * sdkFailureOf(Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' }));
 * // { name: 'ResourceNotFoundException', message: 'gone' }
 */
export function sdkFailureOf(thrown: unknown): SdkFailure {
  try {
    const name = thrown instanceof Error ? thrown.name : ownMember(thrown, 'name');
    const message = thrown instanceof Error ? thrown.message : ownMember(thrown, 'message');
    return {
      // Cut, not marked: the name becomes a reason code, which a truncation marker would spoil.
      name: typeof name === 'string' && name.length > 0 ? name.slice(0, MAX_FAILURE_NAME_LENGTH) : UNNAMED_FAILURE,
      message: typeof message === 'string' ? message : '',
    };
  } catch {
    return { name: UNNAMED_FAILURE, message: 'the thrown value could not be read' };
  }
}

/**
 * Whether a failure says the resource does not exist: Lambda, DynamoDB and CloudWatch Logs
 * `ResourceNotFoundException`, SQS `QueueDoesNotExist`, IAM `NoSuchEntity`, and the CloudFormation
 * `ValidationError` "Stack with id … does not exist".
 *
 * @example
 * isNotFound({ name: 'NoSuchEntityException', message: 'role x' }); // true
 */
export function isNotFound(failure: SdkFailure): boolean {
  if (NOT_FOUND_NAMES.has(failure.name)) {
    return true;
  }
  const { name, message } = failure;
  return name === 'ValidationError' && message.startsWith('Stack with id ') && message.endsWith(' does not exist');
}

/**
 * The structured reason of a failed call, coded by the error name.
 *
 * @example
 * failureReason({ name: 'ThrottlingException', message: 'slow down' }, 'suc1-aaaaaaaa-control', 'a table description');
 * // { code: 'THROTTLING_EXCEPTION', subject: 'suc1-aaaaaaaa-control', detail: 'ThrottlingException: slow down; expected a table description' }
 */
export function failureReason(failure: SdkFailure, subject: string, expected: string): StructuredReason {
  return {
    code: upperSnakeCode(failure.name),
    subject,
    detail: `${failure.name}: ${boundedText(failure.message)}; expected ${expected}`,
  };
}

/**
 * Fetches every page of a listing, at most `maxPages`, refusing a cursor already followed (a
 * service that loops would otherwise page forever).
 *
 * @example
 * const all = await collectPages((cursor) => fetchQueuePage(cursor), 'ListQueues');
 */
export async function collectPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<Reading<Page<T>>>,
  subject: string,
  maxPages: number = MAX_PAGES,
): Promise<Reading<readonly T[]>> {
  let items: readonly T[] = [];
  const followed = new Set<string>();
  let cursor: string | undefined;
  for (let pages = 0; pages < maxPages; pages += 1) {
    const page = await fetchPage(cursor);
    if (!page.ok) {
      return page;
    }
    items = items.concat(page.value.items);
    cursor = page.value.cursor;
    if (cursor === undefined) {
      return ok(items);
    }
    if (followed.has(cursor)) {
      return err(pagingReason('PAGINATION_CURSOR_REPEATED', subject, `cursor ${boundedJsonText(cursor)} repeated`));
    }
    followed.add(cursor);
  }
  return err(pagingReason('PAGINATION_LIMIT_EXCEEDED', subject, `more than ${String(maxPages)} pages`));
}

/**
 * Tags read, or why they could not be, as the tag observation ownership judges.
 *
 * @example
 * tagObservation(ok([{ key: 'suc:run_id', value: id }])); // { kind: 'tagged', tags: [...] }
 */
export function tagObservation(tags: Reading<readonly ResourceTag[]>): TagObservation {
  return tags.ok ? { kind: 'tagged', tags: tags.value } : { kind: 'unknown', reason: tags.error };
}

/**
 * Tags given as a `{ key: value }` map: Lambda `ListTags` and SQS `ListQueueTags` (`Tags`),
 * CloudWatch Logs `ListTagsForResource` (`tags`). An absent map is no tags.
 *
 * @example
 * tagMap({ Tags: { 'suc:run_id': id } }, 'Tags', 'ListTags'); // ok([{ key: 'suc:run_id', value: id }])
 */
export function tagMap(output: unknown, key: string, at: string): Reading<readonly ResourceTag[]> {
  const map = ownMember(output, key);
  if (map === undefined) {
    return ok([]);
  }
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    return malformedOutput(at, key, map, 'a map of tag keys to string values');
  }
  const tags: ResourceTag[] = [];
  for (const [tagKey, value] of Object.entries(map)) {
    if (typeof value !== 'string') {
      return malformedOutput(at, `${key}.${tagKey}`, value, 'a string tag value');
    }
    tags.push({ key: tagKey, value });
  }
  return ok(tags);
}

/**
 * Tags given as `[{ Key, Value }]` under `Tags` (Tagging API, CloudFormation, DynamoDB, IAM).
 *
 * @example
 * tagPairs({ Tags: [{ Key: 'suc:run_id', Value: id }] }, 'ListRoleTags'); // ok([{ key: 'suc:run_id', value: id }])
 */
export function tagPairs(holder: unknown, at: string): Reading<readonly ResourceTag[]> {
  return readEachEntry(holder, 'Tags', at, (pair, where) => {
    const tagKey = requiredText(pair, 'Key', where);
    if (!tagKey.ok) {
      return tagKey;
    }
    const value = ownMember(pair, 'Value');
    return typeof value === 'string'
      ? ok({ key: tagKey.value, value })
      : malformedOutput(where, 'Value', value, 'a string');
  });
}

/**
 * The sighting of one resource on one surface.
 *
 * @example
 * sighting('AWS::SQS::Queue', url, 'queues', { kind: 'tagged', tags: [] });
 */
export function sighting(
  resourceType: string,
  identifier: string,
  surface: LeakAuditSurface,
  tags: TagObservation,
): DiscoveredResource {
  return { resource_type: resourceType, identifier, surface, tags };
}

/**
 * The creation-time member of a sighting, present only when the service reports a time.
 *
 * @example
 * createdAt('2026-10-05T12:00:00.000Z' as UtcMillis); // { created_at: '2026-10-05T12:00:00.000Z' }
 */
export function createdAt(instant: UtcMillis | undefined): { readonly created_at?: UtcMillis } {
  return instant === undefined ? {} : { created_at: instant };
}

/**
 * Reads `holder[key]` as a list (absent is empty) and each entry with `read`; the first failure wins.
 *
 * @example
 * readEachEntry({ QueueUrls: [url] }, 'QueueUrls', 'ListQueues', (entry) => ok(entry)); // ok([url])
 */
export function readEachEntry<T>(
  holder: unknown,
  key: string,
  at: string,
  read: (entry: unknown, where: string) => Reading<T>,
): Reading<readonly T[]> {
  const list = ownMember(holder, key);
  if (list === undefined) {
    return ok([]);
  }
  if (!Array.isArray(list)) {
    return malformedOutput(at, key, list, 'a list');
  }
  const values: T[] = [];
  for (const [index, entry] of (list as readonly unknown[]).entries()) {
    const value = read(entry, `${at}.${key}[${String(index)}]`);
    if (!value.ok) {
      return value;
    }
    values.push(value.value);
  }
  return ok(values);
}

/**
 * The page of `items` continued by `holder[cursorKey]`; an absent, null or empty cursor ends it.
 *
 * @example
 * pageWithCursor([url], { NextToken: 't' }, 'ListQueues', 'NextToken'); // ok({ items: [url], cursor: 't' })
 */
export function pageWithCursor<T>(
  items: readonly T[],
  holder: unknown,
  at: string,
  cursorKey: string,
): Reading<Page<T>> {
  const cursor = ownMember(holder, cursorKey);
  if (cursor === undefined || cursor === null || cursor === '') {
    return ok({ items });
  }
  return typeof cursor === 'string' ? ok({ items, cursor }) : malformedOutput(at, cursorKey, cursor, 'a string cursor');
}

/**
 * A required non-empty string member.
 *
 * @example
 * requiredText({ QueueUrl: url }, 'QueueUrl', 'GetQueueUrl'); // ok(url)
 */
export function requiredText(holder: unknown, key: string, at: string): Reading<string> {
  const value = ownMember(holder, key);
  return typeof value === 'string' && value.length > 0
    ? ok(value)
    : malformedOutput(at, key, value, 'a non-empty string');
}

/**
 * An optional non-empty string member: absent reads `undefined`, anything else must be text.
 *
 * @example
 * optionalText({}, 'EventSourceMappingArn', 'GetEventSourceMapping'); // ok(undefined)
 */
export function optionalText(holder: unknown, key: string, at: string): Reading<string | undefined> {
  return ownMember(holder, key) === undefined ? ok(undefined) : requiredText(holder, key, at);
}

/**
 * An optional SDK `Date` member as a UTC-millis instant.
 *
 * @example
 * optionalInstant({ CreateDate: new Date(0) }, 'CreateDate', 'GetRole.Role'); // ok('1970-01-01T00:00:00.000Z')
 */
export function optionalInstant(holder: unknown, key: string, at: string): Reading<UtcMillis | undefined> {
  const value = ownMember(holder, key);
  if (value === undefined) {
    return ok(undefined);
  }
  const instant = value instanceof Date ? instantOfMillis(value.getTime()) : undefined;
  return instant === undefined ? malformedOutput(at, key, value, 'a valid instant in years 0000-9999') : ok(instant);
}

/**
 * Epoch milliseconds as a UTC-millis instant, or `undefined` for anything that is not a safe
 * integer within years 0000-9999 (NaN, Infinity and fractions included).
 *
 * @example
 * instantOfMillis(0); // '1970-01-01T00:00:00.000Z'
 */
export function instantOfMillis(millis: unknown): UtcMillis | undefined {
  const inRange =
    typeof millis === 'number' && Number.isSafeInteger(millis) && millis >= MIN_INSTANT_MS && millis <= MAX_INSTANT_MS;
  return inRange ? formatUtcMillis(new Date(millis)) : undefined;
}

/**
 * An own member of an object; `undefined` for a non-object, an absent or an inherited member.
 *
 * @example
 * ownMember({}, 'toString'); // undefined
 */
export function ownMember(holder: unknown, key: string): unknown {
  if (typeof holder !== 'object' || holder === null || !Object.hasOwn(holder, key)) {
    return undefined;
  }
  return (holder as Readonly<Record<string, unknown>>)[key];
}

/**
 * The failed reading of a malformed member, naming the value found and the shape expected.
 *
 * @example
 * malformedOutput('ListQueues', 'QueueUrls', 7, 'a list');
 * // err({ code: 'SDK_OUTPUT_MALFORMED', subject: 'ListQueues', detail: 'QueueUrls is 7; expected a list' })
 */
export function malformedOutput(
  at: string,
  key: string,
  value: unknown,
  expected: string,
): Result<never, StructuredReason> {
  return err({
    code: MALFORMED_OUTPUT,
    subject: at,
    detail: `${key} is ${describeValue(value)}; expected ${expected}`,
  });
}

function pagingReason(code: string, subject: string, observed: string): StructuredReason {
  return { code, subject, detail: `${observed}; expected a listing that ends` };
}

// Never the JSON text of a whole value: SDK output may nest without bound or hold a Date or BigInt.
function describeValue(value: unknown): string {
  if (value === undefined || value === null) {
    return value === null ? 'null' : 'absent';
  }
  if (typeof value === 'string') {
    return boundedJsonText(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return Array.isArray(value) ? 'a list' : `a value of type ${value instanceof Date ? 'Date' : typeof value}`;
}
