// What a single-attempt AWS call that may have taken effect settled as (BR-RUA-020, BR-RUA-027,
// D-29). The runner's SQS `SendMessage` of a trial message and its synchronous Lambda `Invoke` of
// the probe caller both run with SDK `maxAttempts: 1`, so a thrown error is the call's only
// outcome, and it is either:
// - `rejected`: the service definitively refused the request, so the message is not on the queue
//   or the function never ran, and nothing started. Only a service exception the SDK deserialized
//   from an HTTP 4xx response whose fault is `client` is definitive: AWS rejects such a request
//   before acting on it (throttling, a missing queue or function, an invalid parameter);
// - `ambiguous`: anything else. A 5xx, a network error or timeout, a body checksum mismatch
//   (`InvalidChecksumError` from the SQS MD5 middleware, thrown after SQS accepted the message),
//   an error with no readable fault or status, or a value that is not an Error at all may hide a
//   call that took effect, so the trial (or probe) counts as started (D-29).
// UNVERIFIED (cloud phase, evidence/CMP-04/decisions.md): that every 4xx client fault of SQS
// `SendMessage` and Lambda `Invoke` is pre-effect. It holds for the documented errors of both
// operations; an undocumented post-effect 4xx would be misread as a rejection.
//
// Every function here is total over any thrown value or service output (Owner amendment A-05):
// own members only, bounded text, and a throwing getter or proxy reads as "unknown", never as a
// crash.

import { ownValue, nonEmptyString } from '../evidence-collection/sdk-values.ts';
import { transportErrorFromThrown } from '../provider-client/provider-invocation-port.ts';
import { boundedText } from '../record-contract/json-value.ts';
import type { TrialMessageSendOutcome } from './trial-execution-ports.ts';

/** How a thrown SDK error settles a single-attempt call. */
export interface SdkCallFailure {
  readonly kind: 'rejected' | 'ambiguous';
  /** The error's name, bounded; `UnrepresentableThrown` when it has none that can be read. */
  readonly code: string;
  readonly detail: string;
}

/** The longest error name a failure code carries. */
export const FAILURE_CODE_LIMIT = 120;
/** The code of a `SendMessage` that returned without every member a sent message has. */
export const SEND_OUTPUT_INCOMPLETE = 'SendMessageOutputIncomplete';

const CLIENT_ERROR_MIN = 400;
const CLIENT_ERROR_MAX = 499;

/**
 * Classifies the error a single-attempt SQS `SendMessage` or Lambda `Invoke` threw.
 *
 * @example
 * classifySendFailure(Object.assign(new Error('gone'), { name: 'QueueDoesNotExist', $fault: 'client', $metadata: { httpStatusCode: 400 } }));
 * // { kind: 'rejected', code: 'QueueDoesNotExist', detail: '...' }
 * classifySendFailure(new Error('InvalidChecksumError')); // { kind: 'ambiguous', code: 'Error', ... }
 */
export function classifySendFailure(thrown: unknown): SdkCallFailure {
  const { error_name: name, message } = transportErrorFromThrown(thrown);
  const status = clientFaultStatus(thrown);
  const code = boundedText(name, FAILURE_CODE_LIMIT);
  if (status !== undefined) {
    return {
      kind: 'rejected',
      code,
      detail: `${code} (HTTP ${String(status)}, client fault): ${boundedText(message)}`,
    };
  }
  return {
    kind: 'ambiguous',
    code,
    detail: `${code} with no definitive client-fault response: ${boundedText(message)}`,
  };
}

/**
 * The outcome of a `SendMessage` that returned: `sent` with SQS's message id, sequence number and
 * body MD5, or `ambiguous` when any is missing, because SQS answered success and the message may
 * be on the queue.
 *
 * @example
 * sentOutcomeOf({ MessageId: 'm-1', SequenceNumber: '1', MD5OfMessageBody: 'abc' }).kind; // 'sent'
 * sentOutcomeOf({}).kind; // 'ambiguous'
 */
export function sentOutcomeOf(output: unknown): TrialMessageSendOutcome {
  try {
    const messageId = nonEmptyString(ownValue(output, 'MessageId'));
    const sequenceNumber = nonEmptyString(ownValue(output, 'SequenceNumber'));
    const md5 = nonEmptyString(ownValue(output, 'MD5OfMessageBody'));
    if (messageId !== undefined && sequenceNumber !== undefined && md5 !== undefined) {
      return { kind: 'sent', message_id: messageId, sequence_number: sequenceNumber, md5_of_message_body: md5 };
    }
  } catch {
    // A throwing getter is no better formed than a missing member.
  }
  return { kind: 'ambiguous', code: SEND_OUTPUT_INCOMPLETE };
}

// The HTTP status of a service exception the SDK built from a 4xx response with a client fault;
// `undefined` for anything else, including a member that cannot be read.
function clientFaultStatus(thrown: unknown): number | undefined {
  try {
    if (!(thrown instanceof Error) || ownValue(thrown, '$fault') !== 'client') {
      return undefined;
    }
    const status = ownValue(ownValue(thrown, '$metadata'), 'httpStatusCode');
    const isClientError =
      typeof status === 'number' &&
      Number.isInteger(status) &&
      status >= CLIENT_ERROR_MIN &&
      status <= CLIENT_ERROR_MAX;
    return isClientError ? status : undefined;
  } catch {
    return undefined;
  }
}
