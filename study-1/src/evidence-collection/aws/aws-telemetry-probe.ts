// CloudWatch Logs, CloudWatch and X-Ray binding of the collector's `TelemetryProbe` port (design
// §5.3, §9.4; BR-RUA-037, AC-RUA-054). WP-25 left the port unbound (evidence/WP-25/decisions.md);
// this binding is made per execution from its log groups, function names and unit start instants
// (`TelemetryBinding`). Thin by construction: each lookup is one paged search per log group, one per
// function or one in all, and the pure `telemetry-targets.ts` decides the unit's targets, its
// window, what each output locates and whether a page is continued. The clients are built with
// region us-east-1 and `maxAttempts: 1`: a lookup that fails is recorded as unavailable telemetry,
// never retried behind the collector's back.
//
// - logs: FilterLogEvents({ logGroupName, filterPattern: the quoted trial or probe id, startTime,
//   endTime, limit: 1 }) per log group of the unit.
// - metrics: ListMetrics({ Namespace: 'AWS/Lambda', MetricName: 'Invocations', Dimensions:
//   [{ Name: 'FunctionName', Value }] }) per function of the unit.
// - traces: GetTraceSummaries({ StartTime, EndTime, FilterExpression: the unit's functions as
//   `service("<name>") OR …` }). The functions have no active tracing, so traces normally read
//   unavailable; that is diagnostic only.
// A page that found nothing but carries a continuation token is followed with that token (a
// FilterLogEvents page "can return empty results while there are more log events available through
// the token"), up to TELEMETRY_PAGE_LIMIT pages; a search still unfinished then is incomplete.
//
// UNVERIFIED (cloud phase, evidence/CMP-03/decisions.md): how many FilterLogEvents pages a real
// search of a run's log group needs; ListMetrics lists a metric that had data in the last two
// weeks, not necessarily inside the unit's window; the X-Ray time-range limits of GetTraceSummaries.

import { CloudWatchClient, ListMetricsCommand } from '@aws-sdk/client-cloudwatch';
import type { CloudWatchClientConfig } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import type { CloudWatchLogsClientConfig } from '@aws-sdk/client-cloudwatch-logs';
import { GetTraceSummariesCommand, XRayClient } from '@aws-sdk/client-xray';
import type { XRayClientConfig } from '@aws-sdk/client-xray';

import type { Result, WallClock } from '../../record-contract/primitives.ts';
import type { CaptureScope } from '../capture-scope.ts';
import type { CollectorReadFailure } from '../collected-records.ts';
import { settleSdkCall } from '../sdk-values.ts';
import type { TelemetryProbe, TelemetrySignal } from '../telemetry-availability.ts';
import {
  LAMBDA_INVOCATIONS_METRIC,
  combineLookups,
  logFilterPattern,
  logLookupOutcome,
  metricLookupOutcome,
  searchContinuation,
  telemetryUnit,
  telemetryWindow,
  traceFilterExpression,
  traceLocators,
  unitFunctionNames,
  unitLogGroups,
} from '../telemetry-targets.ts';
import type { LookupOutcome, TelemetryBinding, TelemetryUnit, TelemetryWindow } from '../telemetry-targets.ts';

export const TELEMETRY_CLIENT_OPTIONS = { region: 'us-east-1', maxAttempts: 1 } as const;
/** The most pages one search reads before it reports the search incomplete. */
export const TELEMETRY_PAGE_LIMIT = 10;
const PINNED_SETTING_NAMES: ReadonlySet<string> = new Set(['region', 'maxAttempts', 'retryStrategy', 'retryMode']);

type PinnedSetting = 'region' | 'maxAttempts' | 'retryStrategy' | 'retryMode';

/** Settings a caller may supply for each client; region and retry behavior are fixed. */
export interface TelemetryClientSettings {
  readonly logs?: Omit<CloudWatchLogsClientConfig, PinnedSetting>;
  readonly metrics?: Omit<CloudWatchClientConfig, PinnedSetting>;
  readonly traces?: Omit<XRayClientConfig, PinnedSetting>;
}

/** The three clients the telemetry lookups use. */
export interface TelemetryClients {
  readonly logs: CloudWatchLogsClient;
  readonly metrics: CloudWatchClient;
  readonly traces: XRayClient;
}

/** What one execution's probe reads with: its clients, its binding and the lookup clock. */
export interface AwsTelemetryProbeDeps {
  readonly clients: TelemetryClients;
  readonly binding: TelemetryBinding;
  readonly clock: WallClock;
}

/**
 * Builds the telemetry clients. Tests pass a scripted `requestHandler` and static credentials per
 * client; production passes nothing.
 *
 * @example
 * const probe = createAwsTelemetryProbe({ clients: createTelemetryClients(), binding, clock });
 */
export function createTelemetryClients(settings: TelemetryClientSettings = {}): TelemetryClients {
  return {
    logs: new CloudWatchLogsClient({ ...withoutPinned(settings.logs), ...TELEMETRY_CLIENT_OPTIONS }),
    metrics: new CloudWatchClient({ ...withoutPinned(settings.metrics), ...TELEMETRY_CLIENT_OPTIONS }),
    traces: new XRayClient({ ...withoutPinned(settings.traces), ...TELEMETRY_CLIENT_OPTIONS }),
  };
}

/**
 * The telemetry probe of one execution: each signal of a unit is located within the unit's window.
 *
 * @example
 * const probe = createAwsTelemetryProbe({ clients, binding, clock });
 * await probe.locate('logs', scope); // { ok: true, value: ['/suc/study-1/<id>/refund-provider'] }
 */
export function createAwsTelemetryProbe(deps: AwsTelemetryProbeDeps): TelemetryProbe {
  return {
    locate: async (
      signal: TelemetrySignal,
      scope: CaptureScope,
    ): Promise<Result<readonly string[], CollectorReadFailure>> => {
      const unit = telemetryUnit(deps.binding, scope);
      if (!unit.ok) {
        return unit;
      }
      const window = telemetryWindow(deps.binding, unit.value, deps.clock.now());
      if (!window.ok) {
        return window;
      }
      return SIGNAL_LOOKUPS[signal](deps, unit.value, window.value);
    },
  };
}

type SignalLookup = (
  deps: AwsTelemetryProbeDeps,
  unit: TelemetryUnit,
  window: TelemetryWindow,
) => Promise<Result<readonly string[], CollectorReadFailure>>;

const SIGNAL_LOOKUPS: Readonly<Record<TelemetrySignal, SignalLookup>> = {
  logs: locateLogs,
  metrics: locateMetrics,
  traces: locateTraces,
};

async function locateLogs(
  deps: AwsTelemetryProbeDeps,
  unit: TelemetryUnit,
  window: TelemetryWindow,
): Promise<Result<readonly string[], CollectorReadFailure>> {
  const outcomes: LookupOutcome[] = [];
  for (const logGroup of unitLogGroups(deps.binding, unit)) {
    const search: PagedSearch<string | undefined> = {
      tokenMember: 'nextToken',
      send: (nextToken) =>
        settleSdkCall(() =>
          deps.clients.logs.send(
            new FilterLogEventsCommand({
              logGroupName: logGroup,
              filterPattern: logFilterPattern(unit.correlation_id),
              startTime: window.start_ms,
              endTime: window.end_ms,
              limit: 1,
              ...(nextToken === undefined ? {} : { nextToken }),
            }),
          ),
        ),
      outcomeOf: (output) => logLookupOutcome(logGroup, output),
    };
    outcomes.push(await searchPages(search, undefined, 1));
  }
  return combineLookups(outcomes);
}

async function locateMetrics(
  deps: AwsTelemetryProbeDeps,
  unit: TelemetryUnit,
): Promise<Result<readonly string[], CollectorReadFailure>> {
  const functionNames = unitFunctionNames(deps.binding, unit);
  if (!functionNames.ok) {
    return functionNames;
  }
  const outcomes: LookupOutcome[] = [];
  for (const functionName of functionNames.value) {
    const search: PagedSearch<string | undefined> = {
      tokenMember: 'NextToken',
      send: (nextToken) =>
        settleSdkCall(() =>
          deps.clients.metrics.send(
            new ListMetricsCommand({
              Namespace: LAMBDA_INVOCATIONS_METRIC.namespace,
              MetricName: LAMBDA_INVOCATIONS_METRIC.metric_name,
              Dimensions: [{ Name: 'FunctionName', Value: functionName }],
              ...(nextToken === undefined ? {} : { NextToken: nextToken }),
            }),
          ),
        ),
      outcomeOf: (output) => metricLookupOutcome(functionName, output),
    };
    outcomes.push(await searchPages(search, undefined, 1));
  }
  return combineLookups(outcomes);
}

async function locateTraces(
  deps: AwsTelemetryProbeDeps,
  unit: TelemetryUnit,
  window: TelemetryWindow,
): Promise<Result<readonly string[], CollectorReadFailure>> {
  const functionNames = unitFunctionNames(deps.binding, unit);
  const filter = functionNames.ok ? traceFilterExpression(functionNames.value) : functionNames;
  if (!filter.ok) {
    return filter;
  }
  const search: PagedSearch<readonly string[]> = {
    tokenMember: 'NextToken',
    send: (nextToken) =>
      settleSdkCall(() =>
        deps.clients.traces.send(
          new GetTraceSummariesCommand({
            StartTime: new Date(window.start_ms),
            EndTime: new Date(window.end_ms),
            FilterExpression: filter.value,
            ...(nextToken === undefined ? {} : { NextToken: nextToken }),
          }),
        ),
      ),
    outcomeOf: traceLocators,
  };
  return searchPages(search, undefined, 1);
}

/** One paged service search: how to send a page and what a page locates. */
interface PagedSearch<T> {
  readonly tokenMember: string;
  readonly send: (nextToken: string | undefined) => Promise<Result<unknown, CollectorReadFailure>>;
  readonly outcomeOf: (output: unknown) => Result<T, CollectorReadFailure>;
}

// Sends pages while a page found nothing but names a continuation (`searchContinuation`), at most
// TELEMETRY_PAGE_LIMIT of them; the last page's outcome stands.
async function searchPages<T>(
  search: PagedSearch<T>,
  nextToken: string | undefined,
  page: number,
): Promise<Result<T, CollectorReadFailure>> {
  const output = await search.send(nextToken);
  if (!output.ok) {
    return output;
  }
  const outcome = search.outcomeOf(output.value);
  const continuation = searchContinuation(outcome, output.value, search.tokenMember);
  if (continuation === undefined || page >= TELEMETRY_PAGE_LIMIT) {
    return outcome;
  }
  return searchPages(search, continuation, page + 1);
}

// A cast can smuggle a pinned key past the type, so pinned keys are dropped at run time too.
function withoutPinned<T extends object>(settings: T | undefined): T {
  const entries = Object.entries(settings ?? {}).filter(([name]) => !PINNED_SETTING_NAMES.has(name));
  return Object.fromEntries(entries) as T;
}
