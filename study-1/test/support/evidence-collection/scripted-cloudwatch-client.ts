// A real CloudWatchClient, built by the telemetry probe's production factory, over a scripted
// HTTP layer (design §12.2). The SDK's own awsJson1_0 serializer (target
// `GraniteServiceVersion20100801`), signer and error deserializer run; only the network is
// replaced by a list of metrics. ListMetrics returns the metrics of the requested namespace and
// name that carry every requested dimension (the API reference: "the dimensions to filter
// against. Only the dimensions that match exactly will be returned"). A listing can be scripted to
// stop early, answering no metric and a `NextToken`. An operation the probe never sends is refused as
// UnsupportedOperation. Every call is recorded with its input.

import type { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import type { HttpRequest, HttpResponse } from '@smithy/types';

import { createTelemetryClients } from '../../../src/evidence-collection/aws/aws-telemetry-probe.ts';
import type { TelemetryClientSettings } from '../../../src/evidence-collection/aws/aws-telemetry-probe.ts';
import { jsonResponse, jsonTargetOperation, requestJson, SCRIPTED_CREDENTIALS } from './scripted-http.ts';
import type { RecordedTelemetryCall, ScriptedServiceError } from './scripted-http.ts';

const METRICS_TARGET_PREFIX = 'GraniteServiceVersion20100801.';
const METRICS_CONTENT_TYPE = 'application/x-amz-json-1.0';

/** One listed metric. */
export interface ScriptedMetric {
  readonly Namespace: string;
  readonly MetricName: string;
  readonly Dimensions: readonly { readonly Name: string; readonly Value: string }[];
}

/**
 * Production-built CloudWatch client over a metric list.
 *
 * @example
 * const metrics = new ScriptedCloudWatchClient();
 * metrics.putMetric({ Namespace: 'AWS/Lambda', MetricName: 'Invocations', Dimensions: [{ Name: 'FunctionName', Value: fn }] });
 */
export class ScriptedCloudWatchClient {
  readonly client: CloudWatchClient;
  readonly #metrics: ScriptedMetric[] = [];
  readonly #errors: ScriptedServiceError[] = [];
  readonly #calls: RecordedTelemetryCall[] = [];
  #stopsEarly = false;

  constructor(settings: TelemetryClientSettings['metrics'] = {}) {
    this.client = createTelemetryClients({
      metrics: {
        ...settings,
        credentials: SCRIPTED_CREDENTIALS,
        requestHandler: { handle: (request: HttpRequest) => this.#handle(request) },
      },
    }).metrics;
  }

  putMetric(metric: ScriptedMetric): void {
    this.#metrics.push(metric);
  }

  /** Every listing stops before it lists anything, with a continuation token. */
  stopListingEarly(): void {
    this.#stopsEarly = true;
  }

  /** The next request fails with this CloudWatch error type. */
  scriptError(type: string, status = 400): void {
    this.#errors.push({ type, status });
  }

  calls(): readonly RecordedTelemetryCall[] {
    return [...this.#calls];
  }

  #handle(request: HttpRequest): Promise<{ response: HttpResponse }> {
    const operation = jsonTargetOperation(request, METRICS_TARGET_PREFIX);
    const input = requestJson(request);
    this.#calls.push({ operation, input });
    const error = this.#errors.shift();
    if (error !== undefined) {
      const body = { __type: `com.amazonaws.cloudwatch#${error.type}`, message: `scripted ${error.type}` };
      return jsonResponse(error.status, METRICS_CONTENT_TYPE, body);
    }
    if (operation !== 'ListMetrics') {
      return jsonResponse(400, METRICS_CONTENT_TYPE, { __type: 'com.amazonaws.cloudwatch#UnsupportedOperation' });
    }
    if (this.#stopsEarly) {
      return jsonResponse(200, METRICS_CONTENT_TYPE, { Metrics: [], NextToken: 'scripted-next' });
    }
    const listed = this.#metrics.filter((metric) => matches(metric, input));
    return jsonResponse(200, METRICS_CONTENT_TYPE, { Metrics: listed.map((metric) => ({ ...metric })) });
  }
}

function matches(metric: ScriptedMetric, input: Readonly<Record<string, unknown>>): boolean {
  const wanted = Array.isArray(input['Dimensions'])
    ? (input['Dimensions'] as readonly ScriptedMetric['Dimensions'][number][])
    : [];
  return (
    metric.Namespace === input['Namespace'] &&
    metric.MetricName === input['MetricName'] &&
    wanted.every((dimension) =>
      metric.Dimensions.some((own) => own.Name === dimension.Name && own.Value === dimension.Value),
    )
  );
}
