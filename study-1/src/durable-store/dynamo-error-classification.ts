// SDK error → WriteOutcome (pure, a mutation target; design §5.3, §15.4).
//
// The distinction decides BR-RUA-033 behavior: a definitive failure is retried with identical
// content, while an ambiguous one stops the writing instance. A wrong "definitive" could hide
// an applied write behind a retry, so only errors that DynamoDB documents as a rejection of
// the request are definitive; everything else (server faults, timeouts, aborts, network
// errors, deserialization failures, unknown names, non-Error values) is ambiguous.
// Sources: https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/CommonErrors.html,
// https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html (Errors),
// https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Programming.Errors.html.

import { decodeStoredItem } from './attribute-value-codec.ts';
import type { WriteOutcome } from './item-store-port.ts';

/**
 * Error names that mean DynamoDB rejected the request without applying it.
 * `TransactionInProgressException` is deliberately absent: it reports that an earlier request
 * with the same ClientRequestToken is still running and may yet commit, so it is ambiguous.
 */
export const DEFINITIVE_ERROR_NAMES: ReadonlySet<string> = new Set([
  'AccessDeniedException',
  'IdempotentParameterMismatchException',
  'IncompleteSignatureException',
  'ItemCollectionSizeLimitExceededException',
  'MissingAuthenticationTokenException',
  'ProvisionedThroughputExceededException',
  'ReplicatedWriteConflictException',
  'RequestLimitExceeded',
  'ResourceNotFoundException',
  'ThrottlingException',
  'TransactionConflictException',
  'UnrecognizedClientException',
  'ValidationException',
]);

/** The code of an error whose properties throw when read (an accessor or a revoked proxy). */
export const UNREADABLE_ERROR_CODE = 'UnreadableError';

const NO_ERROR_REASON = 'None';
const CONDITION_REASON = 'ConditionalCheckFailed';

/**
 * Classifies an error thrown by a DynamoDB write. Total over arbitrary values.
 *
 * @example
 * classifyDynamoError(transactionCanceledWithReasons(['None', 'ConditionalCheckFailed']));
 * // { kind: 'condition_failed', failed_action_index: 1, existing: … }
 * classifyDynamoError(new Error('socket hang up')); // { kind: 'ambiguous', code: 'Error' }
 */
export function classifyDynamoError(error: unknown): WriteOutcome {
  // An error object whose properties throw when read (an accessor or a revoked proxy) cannot be
  // classified; ambiguous is the only safe answer, as it never hides an applied write.
  try {
    return classifyReadableError(error);
  } catch {
    return { kind: 'ambiguous', code: UNREADABLE_ERROR_CODE };
  }
}

function classifyReadableError(error: unknown): WriteOutcome {
  const code = errorCode(error);
  if (code === 'ConditionalCheckFailedException') {
    return conditionFailed(0, propertyOf(error, 'Item'));
  }
  if (code === 'TransactionCanceledException') {
    return classifyCancellation(propertyOf(error, 'CancellationReasons'));
  }
  return DEFINITIVE_ERROR_NAMES.has(code) ? { kind: 'definitive_failure', code } : { kind: 'ambiguous', code };
}

/**
 * Names an error for a result code: the error `name`, or the Node system error `code`
 * (such as `ECONNRESET`) when the name is the generic `Error`.
 *
 * @example
 * errorCode(Object.assign(new Error('reset'), { code: 'ECONNRESET' })); // 'ECONNRESET'
 * errorCode('boom'); // 'NonErrorThrown'
 * errorCode({ get name() { throw new Error('x'); } }); // 'UnreadableError'
 */
export function errorCode(error: unknown): string {
  try {
    return readableErrorCode(error);
  } catch {
    return UNREADABLE_ERROR_CODE;
  }
}

function readableErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return 'NonErrorThrown';
  }
  const name = propertyOf(error, 'name');
  const systemCode = propertyOf(error, 'code');
  if ((name === undefined || name === 'Error') && typeof systemCode === 'string' && systemCode !== '') {
    return systemCode;
  }
  return typeof name === 'string' && name !== '' ? name : 'UnknownError';
}

// A cancelled transaction applied nothing. A failed condition is reported first because it is
// the business signal; otherwise the first non-`None` reason code names the cause.
function classifyCancellation(reasons: unknown): WriteOutcome {
  const list: readonly unknown[] = Array.isArray(reasons) ? reasons : [];
  const conditionIndex = list.findIndex((reason) => propertyOf(reason, 'Code') === CONDITION_REASON);
  if (conditionIndex !== -1) {
    return conditionFailed(conditionIndex, propertyOf(list[conditionIndex], 'Item'));
  }
  const cause = list
    .map((reason) => propertyOf(reason, 'Code'))
    .find((code): code is string => typeof code === 'string' && code !== '' && code !== NO_ERROR_REASON);
  return { kind: 'definitive_failure', code: cause ?? 'TransactionCanceledException' };
}

// `existing` is the ALL_OLD item. It is omitted when the item did not exist, and also when the
// returned item does not decode, because the condition failure itself is certain either way.
function conditionFailed(index: number, rawItem: unknown): WriteOutcome {
  const existing = rawItem === undefined ? undefined : decodeStoredItem(rawItem);
  if (existing?.ok === true) {
    return { kind: 'condition_failed', failed_action_index: index, existing: existing.value };
  }
  return { kind: 'condition_failed', failed_action_index: index };
}

function propertyOf(value: unknown, name: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return (value as Readonly<Record<string, unknown>>)[name];
}
