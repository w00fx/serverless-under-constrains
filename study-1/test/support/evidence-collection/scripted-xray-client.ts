// A real XRayClient, built by the telemetry probe's production factory, over a scripted HTTP
// layer (design §12.2). The SDK's own restJson serializer (POST /TraceSummaries, StartTime and
// EndTime as epoch seconds), signer and error deserializer (`x-amzn-errortype`) run; only the
// network is replaced by a list of traces. GetTraceSummaries returns the traces whose time is
// inside [StartTime, EndTime]. No trace exists unless one is put: the study's functions have no
// active tracing (design §9.4), which is what a real search finds for them. A search can be
// scripted to stop early, answering no summary and a `NextToken`. An operation the probe
// never sends is refused as UnsupportedOperation. Every call is recorded.

import type { XRayClient } from '@aws-sdk/client-xray';
import type { HttpRequest, HttpResponse } from '@smithy/types';

import { createTelemetryClients } from '../../../src/evidence-collection/aws/aws-telemetry-probe.ts';
import type { TelemetryClientSettings } from '../../../src/evidence-collection/aws/aws-telemetry-probe.ts';
import { jsonResponse, requestJson, SCRIPTED_CREDENTIALS } from './scripted-http.ts';
import type { RecordedTelemetryCall, ScriptedServiceError } from './scripted-http.ts';

const XRAY_CONTENT_TYPE = 'application/json';

/** One stored trace: its id and the epoch milliseconds it started. */
export interface ScriptedTrace {
  readonly id: string;
  readonly started_ms: number;
}

/**
 * Production-built X-Ray client over a trace list.
 *
 * @example
 * const traces = new ScriptedXRayClient();
 * traces.putTrace({ id: '1-5f8a2b3c-0123456789abcdef01234567', started_ms: 1791202600000 });
 */
export class ScriptedXRayClient {
  readonly client: XRayClient;
  readonly #traces: ScriptedTrace[] = [];
  readonly #errors: ScriptedServiceError[] = [];
  readonly #calls: RecordedTelemetryCall[] = [];
  #stopsEarly = false;

  constructor(settings: TelemetryClientSettings['traces'] = {}) {
    this.client = createTelemetryClients({
      traces: {
        ...settings,
        credentials: SCRIPTED_CREDENTIALS,
        requestHandler: { handle: (request: HttpRequest) => this.#handle(request) },
      },
    }).traces;
  }

  putTrace(trace: ScriptedTrace): void {
    this.#traces.push(trace);
  }

  /** Every search stops before it finds anything, with a continuation token. */
  stopSearchEarly(): void {
    this.#stopsEarly = true;
  }

  /** The next request fails with this X-Ray error type. */
  scriptError(type: string, status = 400): void {
    this.#errors.push({ type, status });
  }

  calls(): readonly RecordedTelemetryCall[] {
    return [...this.#calls];
  }

  #handle(request: HttpRequest): Promise<{ response: HttpResponse }> {
    const operation = `${request.method} ${request.path}`;
    const input = requestJson(request);
    this.#calls.push({ operation, input });
    const error = this.#errors.shift();
    if (error !== undefined) {
      return jsonResponse(
        error.status,
        XRAY_CONTENT_TYPE,
        { message: `scripted ${error.type}` },
        {
          'x-amzn-errortype': error.type,
        },
      );
    }
    if (operation !== 'POST /TraceSummaries') {
      return jsonResponse(
        404,
        XRAY_CONTENT_TYPE,
        { message: operation },
        { 'x-amzn-errortype': 'UnsupportedOperation' },
      );
    }
    if (this.#stopsEarly) {
      return jsonResponse(200, XRAY_CONTENT_TYPE, { TraceSummaries: [], NextToken: 'scripted-next' });
    }
    const start = Number(input['StartTime']) * 1000;
    const end = Number(input['EndTime']) * 1000;
    const found = this.#traces.filter((trace) => trace.started_ms >= start && trace.started_ms <= end);
    return jsonResponse(200, XRAY_CONTENT_TYPE, { TraceSummaries: found.map((trace) => ({ Id: trace.id })) });
  }
}
