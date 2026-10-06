// The HTTP layer shared by the scripted telemetry clients (design §12.2): a real SDK client sends
// its serialized request to a `requestHandler`, and these helpers decode the JSON body and build
// the service's JSON response, so each fake models only its service's behavior.

import { Readable } from 'node:stream';

import type { HttpRequest, HttpResponse } from '@smithy/types';

import type { JsonObject } from '../../../src/record-contract/primitives.ts';

/** One request as a fake records it: the operation and its decoded JSON input. */
export interface RecordedTelemetryCall {
  readonly operation: string;
  readonly input: JsonObject;
}

/** A scripted service error: its SDK error name and HTTP status. */
export interface ScriptedServiceError {
  readonly type: string;
  readonly status: number;
}

/**
 * The JSON body of a serialized SDK request.
 *
 * @example
 * requestJson(request)['logGroupName']; // '/suc/study-1/<id>/refund-provider'
 */
export function requestJson(request: HttpRequest): JsonObject {
  const body: unknown = request.body;
  if (!(body instanceof Uint8Array)) {
    throw new TypeError(`request body is ${typeof body}; expected the SDK's Uint8Array JSON body`);
  }
  return JSON.parse(new TextDecoder().decode(body)) as JsonObject;
}

/**
 * A JSON response with the given status, content type and extra headers.
 *
 * @example
 * return jsonResponse(200, 'application/x-amz-json-1.1', { events: [] });
 */
export function jsonResponse(
  status: number,
  contentType: string,
  body: JsonObject,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ response: HttpResponse }> {
  return Promise.resolve({
    response: {
      statusCode: status,
      headers: { 'content-type': contentType, ...headers },
      body: Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]),
    },
  });
}

/**
 * The operation an awsJson request names in its `x-amz-target` header, without the service prefix.
 *
 * @example
 * jsonTargetOperation(request, 'Logs_20140328.'); // 'FilterLogEvents'
 */
export function jsonTargetOperation(request: HttpRequest, prefix: string): string {
  const target = request.headers['x-amz-target'] ?? '';
  return target.startsWith(prefix) ? target.slice(prefix.length) : target;
}

/** Static credentials for a scripted client; never a real secret. */
export const SCRIPTED_CREDENTIALS = {
  accessKeyId: 'AKIDSCRIPTEDTELEMETRY',
  secretAccessKey: 'scripted-telemetry-not-a-secret',
} as const;
