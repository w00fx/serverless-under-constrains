// A real CloudWatchLogsClient, built by the telemetry probe's production factory, over a scripted
// HTTP layer (design §12.2). The SDK's own awsJson1_1 serializer, signer and error deserializer
// run; only the network is replaced by a model of log groups. FilterLogEvents returns, up to
// `limit`, the events of the named group whose message contains the quoted term of the filter
// pattern and whose timestamp is inside [startTime, endTime] (both ends included, as the API
// reference says "events with a timestamp before/later than this time are not returned"). An
// unknown group fails with ResourceNotFoundException, and an operation the probe never sends is
// refused as UnsupportedOperation. A group can be scripted to stop its search early: its first
// pages answer no event and a `nextToken` naming the next page, and a request carrying that token
// continues the search ("this operation can return empty results while there are more log events
// available through the token"). Every call is recorded with its decoded input.

import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import type { HttpRequest, HttpResponse } from '@smithy/types';

import { createTelemetryClients } from '../../../src/evidence-collection/aws/aws-telemetry-probe.ts';
import type { TelemetryClientSettings } from '../../../src/evidence-collection/aws/aws-telemetry-probe.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import {
  jsonResponse,
  jsonTargetOperation,
  requestJson,
  SCRIPTED_CREDENTIALS,
  scriptedPage,
  scriptedPageToken,
} from './scripted-http.ts';
import type { RecordedTelemetryCall, ScriptedServiceError } from './scripted-http.ts';

const LOGS_TARGET_PREFIX = 'Logs_20140328.';
const LOGS_CONTENT_TYPE = 'application/x-amz-json-1.1';

/** One stored log event. */
export interface ScriptedLogEvent {
  readonly timestamp: number;
  readonly message: string;
}

interface LogGroupModel {
  readonly events: ScriptedLogEvent[];
  /** How many pages of each search answer nothing before the matching events. */
  emptyPages: number;
}

/**
 * Production-built CloudWatch Logs client over a log-group model.
 *
 * @example
 * const logs = new ScriptedCloudWatchLogsClient();
 * logs.putEvent('/suc/study-1/<id>/refund-provider', { timestamp: 1791202600000, message: `"trial_id":"${trialId}"` });
 * await logs.client.send(new FilterLogEventsCommand({ logGroupName, filterPattern: `"${trialId}"`, limit: 1 }));
 */
export class ScriptedCloudWatchLogsClient {
  readonly client: CloudWatchLogsClient;
  readonly #groups = new Map<string, LogGroupModel>();
  readonly #errors: ScriptedServiceError[] = [];
  readonly #calls: RecordedTelemetryCall[] = [];

  constructor(settings: TelemetryClientSettings['logs'] = {}) {
    this.client = createTelemetryClients({
      logs: {
        ...settings,
        credentials: SCRIPTED_CREDENTIALS,
        requestHandler: { handle: (request: HttpRequest) => this.#handle(request) },
      },
    }).logs;
  }

  /** Creates the group if needed (a stack-owned group exists before any event). */
  createGroup(logGroupName: string): void {
    this.#group(logGroupName);
  }

  putEvent(logGroupName: string, event: ScriptedLogEvent): void {
    this.#group(logGroupName).events.push(event);
  }

  /** The first `pages` pages of every search of the group (all of them by default) find nothing and name the next page. */
  stopSearchEarly(logGroupName: string, pages = Number.POSITIVE_INFINITY): void {
    this.#group(logGroupName).emptyPages = pages;
  }

  /** The next request fails with this CloudWatch Logs error type. */
  scriptError(type: string, status = 400): void {
    this.#errors.push({ type, status });
  }

  calls(): readonly RecordedTelemetryCall[] {
    return [...this.#calls];
  }

  #group(logGroupName: string): LogGroupModel {
    const existing = this.#groups.get(logGroupName);
    if (existing !== undefined) {
      return existing;
    }
    const created: LogGroupModel = { events: [], emptyPages: 0 };
    this.#groups.set(logGroupName, created);
    return created;
  }

  #handle(request: HttpRequest): Promise<{ response: HttpResponse }> {
    const operation = jsonTargetOperation(request, LOGS_TARGET_PREFIX);
    const input = requestJson(request);
    this.#calls.push({ operation, input });
    const error = this.#errors.shift();
    if (error !== undefined) {
      return jsonResponse(error.status, LOGS_CONTENT_TYPE, { __type: error.type, message: `scripted ${error.type}` });
    }
    if (operation !== 'FilterLogEvents') {
      return jsonResponse(400, LOGS_CONTENT_TYPE, { __type: 'UnsupportedOperation', message: operation });
    }
    const group = this.#groups.get(typeof input['logGroupName'] === 'string' ? input['logGroupName'] : '');
    if (group === undefined) {
      return jsonResponse(400, LOGS_CONTENT_TYPE, { __type: 'ResourceNotFoundException', message: 'no such group' });
    }
    const page = scriptedPage(input['nextToken']);
    if (page <= group.emptyPages) {
      return jsonResponse(200, LOGS_CONTENT_TYPE, { events: [], nextToken: scriptedPageToken(page + 1) });
    }
    return jsonResponse(200, LOGS_CONTENT_TYPE, { events: matchingEvents(group.events, input) });
  }
}

// The quoted term of a filter pattern must appear in the message (exact phrase match).
function matchingEvents(events: readonly ScriptedLogEvent[], input: Readonly<Record<string, unknown>>): JsonObject[] {
  const pattern = typeof input['filterPattern'] === 'string' ? input['filterPattern'] : '';
  const term = pattern.startsWith('"') && pattern.endsWith('"') ? pattern.slice(1, -1) : pattern;
  const start = typeof input['startTime'] === 'number' ? input['startTime'] : Number.NEGATIVE_INFINITY;
  const end = typeof input['endTime'] === 'number' ? input['endTime'] : Number.POSITIVE_INFINITY;
  const limit = typeof input['limit'] === 'number' ? input['limit'] : 10_000;
  return events
    .filter((event) => event.message.includes(term) && event.timestamp >= start && event.timestamp <= end)
    .slice(0, limit)
    .map((event, index) => ({ ...event, eventId: `event-${String(index)}`, logStreamName: 'scripted-stream' }));
}
