// Lambda durable-execution responses mapped to the `durable_execution_metadata` shapes (design
// §5.3 `DurableExecutionReader`, catalogue row 62; BR-RUA-020, BR-RUA-037). The port hands the
// collector the SDK objects of ListDurableExecutionsByFunction, GetDurableExecution and
// GetDurableExecutionHistory unchanged; this module is the only reader of their members, so the
// AWS adapter stays a thin call and the mapping is a pure, tested target (design §15.4).
//
// History events keep the service spelling of `EventType`. The detail members the study reads sit
// under `<EventType>Details` (`StepFailedDetails.RetryDetails.CurrentAttempt`,
// `InvocationCompletedDetails.RequestId`, `…Details.Error.Payload.ErrorType`); a member of another
// shape is left out, never guessed.

import { err, ok } from '../record-contract/primitives.ts';
import type { Result } from '../record-contract/primitives.ts';
import type {
  DurableExecutionRecord,
  DurableHistoryEvent,
} from '../record-contract/records/group-b/durable_execution_metadata.ts';
import { DURABLE_EXECUTION_STATUSES } from '../record-contract/records/group-b/vocabulary.ts';
import type { DurableExecutionStatus } from '../record-contract/records/group-b/vocabulary.ts';
import { instantOfDate, nonEmptyString, ownValue, quoted, safeCount } from './sdk-values.ts';

/** An execution as ListDurableExecutionsByFunction or GetDurableExecution returns it; untrusted. */
export interface SdkDurableExecution {
  readonly DurableExecutionArn?: unknown;
  readonly DurableExecutionName?: unknown;
  readonly Status?: unknown;
  readonly StartTimestamp?: unknown;
  readonly EndTimestamp?: unknown;
  readonly Version?: unknown;
}

/** A history event as GetDurableExecutionHistory returns it; untrusted. */
export interface SdkHistoryEvent {
  readonly EventType?: unknown;
  readonly EventId?: unknown;
  readonly Name?: unknown;
  readonly EventTimestamp?: unknown;
}

/** An execution's identity and lifecycle, without its history. */
export type DurableExecutionSummary = Omit<DurableExecutionRecord, 'history_complete' | 'history'>;

const EVENT_TYPE = /^[A-Z][A-Za-z]*$/;

/**
 * Maps one execution of a listing or a GetDurableExecution response.
 *
 * @example
 * mapDurableExecution({ DurableExecutionArn: arn, DurableExecutionName: 'n', Status: 'RUNNING', StartTimestamp: new Date() });
 */
export function mapDurableExecution(execution: SdkDurableExecution): Result<DurableExecutionSummary, string> {
  const arn = nonEmptyString(ownValue(execution, 'DurableExecutionArn'));
  const name = nonEmptyString(ownValue(execution, 'DurableExecutionName'));
  const status = statusOf(ownValue(execution, 'Status'));
  const startedAt = instantOfDate(ownValue(execution, 'StartTimestamp'));
  if (arn === undefined || name === undefined || status === undefined || startedAt === undefined) {
    return err(
      `durable execution ${quoted(ownValue(execution, 'DurableExecutionArn'))} has name ${quoted(ownValue(execution, 'DurableExecutionName'))}, status ${quoted(ownValue(execution, 'Status'))} and start ${quoted(ownValue(execution, 'StartTimestamp'))}; expected a non-empty arn and name, a status in ${DURABLE_EXECUTION_STATUSES.join(', ')} and a valid start Date`,
    );
  }
  const optional = optionalExecutionMembers(execution);
  if (!optional.ok) {
    return optional;
  }
  return ok({
    durable_execution_arn: arn,
    durable_execution_name: name,
    status,
    started_at: startedAt,
    ...optional.value,
  });
}

/**
 * Maps one history event, keeping the service's event type and the detail members the study reads.
 *
 * @example
 * mapHistoryEvent({ EventType: 'InvocationCompleted', EventId: 4, EventTimestamp: at, InvocationCompletedDetails: { RequestId: 'r' } });
 * // { ok: true, value: { history_event_id: 4, event_type: 'InvocationCompleted', event_timestamp: '…', request_id: 'r' } }
 */
export function mapHistoryEvent(event: SdkHistoryEvent): Result<DurableHistoryEvent, string> {
  const eventType = ownValue(event, 'EventType');
  const timestamp = instantOfDate(ownValue(event, 'EventTimestamp'));
  if (typeof eventType !== 'string' || !EVENT_TYPE.test(eventType) || timestamp === undefined) {
    return err(
      `history event type ${quoted(eventType)} at ${quoted(ownValue(event, 'EventTimestamp'))}; expected a PascalCase event type and a valid EventTimestamp Date`,
    );
  }
  const details = ownValue(event, `${eventType}Details`);
  const retry = ownValue(details, 'RetryDetails');
  const members = {
    history_event_id: optionalMember(ownValue(event, 'EventId'), (value) => safeCount(value, 0)),
    name: optionalMember(ownValue(event, 'Name'), nonEmptyString),
    current_attempt: optionalMember(ownValue(retry, 'CurrentAttempt'), (value) => safeCount(value, 1)),
    next_attempt_delay_seconds: optionalMember(ownValue(retry, 'NextAttemptDelaySeconds'), (value) =>
      safeCount(value, 0),
    ),
    request_id: optionalMember(ownValue(details, 'RequestId'), nonEmptyString),
    error_type: optionalMember(ownValue(ownValue(ownValue(details, 'Error'), 'Payload'), 'ErrorType'), nonEmptyString),
  };
  const present: Record<string, string | number> = {};
  for (const [member, read] of Object.entries(members)) {
    if (!read.ok) {
      return err(
        `history event ${eventType} member ${member} is ${quoted(read.error)}; expected the service shape of that member`,
      );
    }
    if (read.value !== undefined) {
      present[member] = read.value;
    }
  }
  return ok({ ...present, event_type: eventType, event_timestamp: timestamp });
}

function statusOf(value: unknown): DurableExecutionStatus | undefined {
  return DURABLE_EXECUTION_STATUSES.find((status) => status === value);
}

function optionalExecutionMembers(
  execution: SdkDurableExecution,
): Result<Pick<DurableExecutionSummary, 'ended_at' | 'version'>, string> {
  const endedAt = optionalMember(ownValue(execution, 'EndTimestamp'), instantOfDate);
  const version = optionalMember(ownValue(execution, 'Version'), nonEmptyString);
  if (!endedAt.ok || !version.ok) {
    return err(
      `durable execution ${quoted(ownValue(execution, 'DurableExecutionArn'))} has end ${quoted(ownValue(execution, 'EndTimestamp'))} and version ${quoted(ownValue(execution, 'Version'))}; expected an absent or valid end Date and an absent or non-empty version`,
    );
  }
  return ok({
    ...(endedAt.value === undefined ? {} : { ended_at: endedAt.value }),
    ...(version.value === undefined ? {} : { version: version.value }),
  });
}

// An absent member is fine; a present one must read as the expected shape.
function optionalMember<T>(value: unknown, read: (value: unknown) => T | undefined): Result<T | undefined, unknown> {
  if (value === undefined) {
    return ok(undefined);
  }
  const parsed = read(value);
  return parsed === undefined ? err(value) : ok(parsed);
}
