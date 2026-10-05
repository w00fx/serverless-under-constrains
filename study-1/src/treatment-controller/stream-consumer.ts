// The invocation body of the controller function: a DynamoDB stream event of the caller
// journal, one record per batch (BatchSize 1, design §9.5). Each record is read, handed to the
// controller and logged as one JSON line. A record that cannot be read is logged and skipped:
// retrying identical bytes cannot make them readable. A failure of the controller is logged and
// rethrown, so Lambda reports a function error and the mapping retries within its bound.

import type { Result } from '../record-contract/primitives.ts';
import { ControllerFault } from './controller-fault.ts';
import type { ControllerFaultLog } from './controller-fault.ts';
import type { ControllerOutcome } from './treatment-controller.ts';
import type { StreamInsertRecord } from './stream-record.ts';
import { unmarshallStreamRecord } from './stream-record.ts';

/** The controller as the consumer sees it. */
export interface StreamRecordHandler {
  handle(record: StreamInsertRecord): Promise<ControllerOutcome>;
}

export type ControllerLogLine =
  | ({
      readonly level: 'info';
      readonly event: 'controller_record_handled';
      readonly sequence_number: string;
    } & ControllerOutcome)
  | {
      readonly level: 'warn';
      readonly event: 'stream_record_unreadable';
      readonly code: string;
      readonly detail: string;
    }
  | { readonly level: 'warn'; readonly event: 'stream_event_unreadable'; readonly detail: string }
  | ControllerFaultLog
  | { readonly level: 'error'; readonly event: 'controller_error'; readonly detail: string };

/** Where log lines go: stdout in Lambda, a recording fake in tests. */
export type ControllerLogSink = (line: ControllerLogLine) => void;

/**
 * Consumes one stream event, record by record and in order.
 *
 * @example
 * await consumeStreamEvent(event, controller, (line) => process.stdout.write(`${JSON.stringify(line)}\n`));
 */
export async function consumeStreamEvent(
  event: unknown,
  controller: StreamRecordHandler,
  log: ControllerLogSink,
): Promise<void> {
  const records = streamRecords(event);
  if (!records.ok) {
    log({ level: 'warn', event: 'stream_event_unreadable', detail: records.error });
    return;
  }
  for (const raw of records.value) {
    await consumeRecord(raw, controller, log);
  }
}

async function consumeRecord(raw: unknown, controller: StreamRecordHandler, log: ControllerLogSink): Promise<void> {
  const record = unmarshallStreamRecord(raw);
  if (!record.ok) {
    log({ level: 'warn', event: 'stream_record_unreadable', code: record.error.code, detail: record.error.detail });
    return;
  }
  try {
    const outcome = await controller.handle(record.value);
    log({
      level: 'info',
      event: 'controller_record_handled',
      sequence_number: record.value.sequence_number,
      ...outcome,
    });
  } catch (error) {
    log(
      error instanceof ControllerFault
        ? error.toLog()
        : { level: 'error', event: 'controller_error', detail: String(error) },
    );
    throw error;
  }
}

function streamRecords(event: unknown): Result<readonly unknown[], string> {
  const records =
    typeof event === 'object' && event !== null ? (event as { readonly Records?: unknown }).Records : undefined;
  return Array.isArray(records)
    ? { ok: true, value: records as readonly unknown[] }
    : { ok: false, error: `stream event Records is ${typeof records}; expected an array of stream records` };
}
