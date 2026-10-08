// What telemetry belongs to a capture unit (BR-RUA-037, AC-RUA-054; design §9.4, §9.7), and how
// a lookup's service output becomes locators. Telemetry is diagnostic only, so every decision here
// only says whether a signal could be located; none feeds a verdict.
//
// A unit's functions are its caller (the trial's variant caller, or the probe caller), the refund
// provider and the treatment controller. Each has the explicit stack-owned log group
// `/suc/study-1/<execution_id>/<logical>` (A-13) and a CloudFormation-generated function name the
// resource manifest records (no explicit names, [R-durable]), which the binding supplies. The
// unit's window runs from the instant the unit started to the lookup instant, its log events are
// found by the quoted trial id, or for the probe the quoted transport-probe id, and its traces by
// the X-Ray service nodes of its functions (never every trace of the account in the window).
//
// The mapping reads SDK outputs as untrusted input (Owner amendment A-05): own members only, and a
// lookup that stopped early (an empty page with a continuation token) is continued, and reported
// as incomplete rather than as nothing found when it never finishes.

import { executionIdOf } from '../event-journal/journal-scope.ts';
import { logGroupName } from '../../infra/ownership/resource-naming.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, UtcMillis, Uuid4, VariantId } from '../record-contract/primitives.ts';
import type { CaptureScope } from './capture-scope.ts';
import type { CollectorReadFailure } from './collected-records.ts';
import { nonEmptyString, ownValue } from './sdk-values.ts';

/** The logical names of the functions telemetry is looked up for (design §9.4). */
export const TELEMETRY_FUNCTION_ROLES = [
  'conventional-caller',
  'durable-caller',
  'probe-caller',
  'refund-provider',
  'treatment-controller',
] as const;
export type TelemetryFunctionRole = (typeof TELEMETRY_FUNCTION_ROLES)[number];

/** The metric whose presence locates a function's metrics. */
export const LAMBDA_INVOCATIONS_METRIC = { namespace: 'AWS/Lambda', metric_name: 'Invocations' } as const;

/** One execution's telemetry facts: its id, its deployed function names, its trials and their start instants. */
export interface TelemetryBinding {
  readonly execution_id: Uuid4;
  /** The deployed function name of each logical function (resource manifest physical ids). */
  readonly function_names: Readonly<Partial<Record<TelemetryFunctionRole, string>>>;
  /** The variant of every declared trial (execution manifest). */
  readonly trial_variants: ReadonlyMap<string, VariantId>;
  /** The instant each unit started, by trial id or `probe`; filled as units start. */
  readonly unit_started_at: ReadonlyMap<string, UtcMillis>;
}

/** The functions and correlation id of one unit. */
export interface TelemetryUnit {
  /** The trial id, or the probe's transport-probe id: what the unit's log lines carry. */
  readonly correlation_id: string;
  /** The key of the unit's start instant: the trial id or `probe`. */
  readonly unit_key: string;
  readonly roles: readonly TelemetryFunctionRole[];
}

/** A lookup window in epoch milliseconds, inclusive at both ends. */
export interface TelemetryWindow {
  readonly start_ms: number;
  readonly end_ms: number;
}

/** One lookup's answer: a locator found, nothing found, or why it could not tell. */
export type LookupOutcome = Result<string | undefined, CollectorReadFailure>;

const SHARED_ROLES: readonly TelemetryFunctionRole[] = ['refund-provider', 'treatment-controller'];
const PROBE_UNIT_KEY = 'probe';
// A Lambda function name: 1 to 64 letters, digits, hyphens or underscores (Lambda API reference,
// FunctionName). Such a name can be quoted in an X-Ray filter expression as it is.
const LAMBDA_FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The unit a capture scope names within the bound execution, or why it is not bound.
 *
 * @example
 * telemetryUnit(binding, trialScope); // { correlation_id: trialId, unit_key: trialId, roles: ['durable-caller', …] }
 */
export function telemetryUnit(
  binding: TelemetryBinding,
  scope: CaptureScope,
): Result<TelemetryUnit, CollectorReadFailure> {
  const executionId = executionIdOf(scope.execution);
  if (executionId !== binding.execution_id) {
    return err({ code: 'TelemetryExecutionUnbound' });
  }
  if (scope.unit.kind === 'probe') {
    return ok({ correlation_id: executionId, unit_key: PROBE_UNIT_KEY, roles: ['probe-caller', ...SHARED_ROLES] });
  }
  const trialId = scope.unit.trial_id;
  const variant = binding.trial_variants.get(trialId);
  if (variant === undefined) {
    return err({ code: 'TelemetryTrialUnbound' });
  }
  return ok({ correlation_id: trialId, unit_key: trialId, roles: [`${variant}-caller`, ...SHARED_ROLES] });
}

/**
 * The unit's lookup window: from its start instant to `now`, or why it has none.
 *
 * @example
 * telemetryWindow(binding, unit, now); // { ok: true, value: { start_ms: 1791202500000, end_ms: 1791203400000 } }
 */
export function telemetryWindow(
  binding: TelemetryBinding,
  unit: TelemetryUnit,
  now: Date,
): Result<TelemetryWindow, CollectorReadFailure> {
  const started = binding.unit_started_at.get(unit.unit_key);
  const startMs = started === undefined ? Number.NaN : Date.parse(started);
  const endMs = now.getTime();
  if (!Number.isFinite(startMs)) {
    return err({ code: 'TelemetryWindowUnknown' });
  }
  return startMs <= endMs ? ok({ start_ms: startMs, end_ms: endMs }) : err({ code: 'TelemetryWindowInverted' });
}

/**
 * The unit's log groups, one per function, in role order.
 *
 * @example
 * unitLogGroups(binding, unit); // ['/suc/study-1/<id>/durable-caller', '/suc/study-1/<id>/refund-provider', …]
 */
export function unitLogGroups(binding: TelemetryBinding, unit: TelemetryUnit): readonly string[] {
  return unit.roles.map((role) => logGroupName(binding.execution_id, role));
}

/**
 * The unit's deployed function names, in role order, or why one is not bound.
 *
 * @example
 * unitFunctionNames(binding, unit); // { ok: true, value: ['SucRua-run-3f1c2a9e-DurableCaller…', …] }
 */
export function unitFunctionNames(
  binding: TelemetryBinding,
  unit: TelemetryUnit,
): Result<readonly string[], CollectorReadFailure> {
  const names: string[] = [];
  for (const role of unit.roles) {
    const name = nonEmptyString(ownValue(binding.function_names, role));
    if (name === undefined) {
      return err({ code: 'TelemetryFunctionUnbound' });
    }
    names.push(name);
  }
  return ok(names);
}

/**
 * The CloudWatch Logs filter pattern that matches a log event containing the id as a term.
 *
 * @example
 * logFilterPattern('3f1c2a9e-…'); // '"3f1c2a9e-…"'
 */
export function logFilterPattern(correlationId: string): string {
  return `"${correlationId}"`;
}

/**
 * A FilterLogEvents output for one log group: the group when it returned an event, nothing found
 * when the search finished empty, and incomplete when it stopped with a continuation token.
 *
 * @example
 * logLookupOutcome('/suc/study-1/<id>/refund-provider', { events: [{ message: '…' }] }); // { ok: true, value: '/suc/…' }
 */
export function logLookupOutcome(logGroup: string, output: unknown): LookupOutcome {
  return pageOutcome(output, 'events', 'nextToken', 'LogSearchIncomplete', () => logGroup);
}

/**
 * A ListMetrics output for one function: its Invocations metric locator when listed, nothing when
 * the listing finished empty, and incomplete when it stopped with a continuation token.
 *
 * @example
 * metricLookupOutcome('fn', { Metrics: [{ Namespace: 'AWS/Lambda', MetricName: 'Invocations', Dimensions: [...] }] });
 * // { ok: true, value: 'AWS/Lambda:Invocations:FunctionName=fn' }
 */
export function metricLookupOutcome(functionName: string, output: unknown): LookupOutcome {
  const matching = (metric: unknown): boolean => isInvocationsMetricOf(functionName, metric);
  return pageOutcome(output, 'Metrics', 'NextToken', 'MetricListIncomplete', (metrics) =>
    metrics.some(matching) ? metricLocator(functionName) : undefined,
  );
}

/**
 * The locator of a function's Invocations metric.
 *
 * @example
 * metricLocator('fn'); // 'AWS/Lambda:Invocations:FunctionName=fn'
 */
export function metricLocator(functionName: string): string {
  return `${LAMBDA_INVOCATIONS_METRIC.namespace}:${LAMBDA_INVOCATIONS_METRIC.metric_name}:FunctionName=${functionName}`;
}

/**
 * The X-Ray filter expression that keeps only the traces through one of the unit's functions, or
 * why it cannot be written. Without it GetTraceSummaries lists every trace of the account in the
 * window, so a traced workload elsewhere would be recorded as this unit's traces. `service("<name>")`
 * matches both nodes a Lambda function makes (the function and the service), both named after the
 * function (X-Ray filter expressions, "id function"). A name outside the Lambda function-name shape
 * is refused rather than written into the expression.
 *
 * @example
 * traceFilterExpression(['fn-a', 'fn-b']); // { ok: true, value: 'service("fn-a") OR service("fn-b")' }
 */
export function traceFilterExpression(functionNames: readonly string[]): Result<string, CollectorReadFailure> {
  if (functionNames.length === 0 || !functionNames.every((name) => LAMBDA_FUNCTION_NAME.test(name))) {
    return err({ code: 'TelemetryFunctionNameInvalid' });
  }
  return ok(functionNames.map((name) => `service("${name}")`).join(' OR '));
}

/**
 * The token to continue a search with: the page's own non-empty continuation token when the page's
 * outcome is a failure (a search that stopped before it found anything), otherwise none. A
 * FilterLogEvents page "can return empty results while there are more log events available through
 * the token", so a lookup follows it before it reports the search incomplete.
 *
 * @example
 * searchContinuation({ ok: false, error: { code: 'LogSearchIncomplete' } }, { nextToken: 't' }, 'nextToken'); // 't'
 */
export function searchContinuation(
  outcome: Result<unknown, CollectorReadFailure>,
  output: unknown,
  tokenMember: string,
): string | undefined {
  return outcome.ok ? undefined : nonEmptyString(ownValue(output, tokenMember));
}

/**
 * The trace ids a GetTraceSummaries output lists, each once; incomplete when it listed none but
 * stopped with a continuation token.
 *
 * @example
 * traceLocators({ TraceSummaries: [{ Id: '1-5f8a…' }] }); // { ok: true, value: ['1-5f8a…'] }
 */
export function traceLocators(output: unknown): Result<readonly string[], CollectorReadFailure> {
  const ids = listOf(ownValue(output, 'TraceSummaries')).flatMap((summary) => {
    const id = nonEmptyString(ownValue(summary, 'Id'));
    return id === undefined ? [] : [id];
  });
  if (ids.length === 0 && nonEmptyString(ownValue(output, 'NextToken')) !== undefined) {
    return err({ code: 'TraceSearchIncomplete' });
  }
  return ok([...new Set(ids)]);
}

/**
 * Combines one signal's lookups: every locator found, else the first failure, else nothing found.
 * A signal located through one function stays available although another lookup failed, because
 * telemetry is diagnostic and any locator is a usable reference (BR-RUA-037).
 *
 * @example
 * combineLookups([{ ok: false, error: { code: 'ThrottlingException' } }, { ok: true, value: 'g' }]); // { ok: true, value: ['g'] }
 */
export function combineLookups(outcomes: readonly LookupOutcome[]): Result<readonly string[], CollectorReadFailure> {
  const found = outcomes.flatMap((outcome) => (outcome.ok && outcome.value !== undefined ? [outcome.value] : []));
  const failure = outcomes.find((outcome) => !outcome.ok);
  if (found.length > 0 || failure === undefined) {
    return ok(found);
  }
  return failure;
}

// One page of a list operation: found when `locate` finds something in the list, incomplete when
// the page is empty but carries a continuation token, otherwise nothing found.
function pageOutcome(
  output: unknown,
  listMember: string,
  tokenMember: string,
  incompleteCode: string,
  locate: (items: readonly unknown[]) => string | undefined,
): LookupOutcome {
  const items = listOf(ownValue(output, listMember));
  const located = items.length === 0 ? undefined : locate(items);
  if (located !== undefined) {
    return ok(located);
  }
  return nonEmptyString(ownValue(output, tokenMember)) === undefined ? ok(undefined) : err({ code: incompleteCode });
}

function isInvocationsMetricOf(functionName: string, metric: unknown): boolean {
  if (
    ownValue(metric, 'Namespace') !== LAMBDA_INVOCATIONS_METRIC.namespace ||
    ownValue(metric, 'MetricName') !== LAMBDA_INVOCATIONS_METRIC.metric_name
  ) {
    return false;
  }
  return listOf(ownValue(metric, 'Dimensions')).some(
    (dimension) => ownValue(dimension, 'Name') === 'FunctionName' && ownValue(dimension, 'Value') === functionName,
  );
}

function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}
