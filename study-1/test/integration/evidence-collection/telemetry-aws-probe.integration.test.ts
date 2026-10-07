// The AWS binding of the telemetry probe over scripted request handlers (BR-RUA-037, AC-RUA-054;
// design §5.3, §9.4, §12.2). Real SDK clients built by `createTelemetryClients` serialize every
// request; the scripted clients answer as CloudWatch Logs, CloudWatch and X-Ray do. Proves the
// exact wire requests (quoted filter term, the unit window, limit 1, the Lambda Invocations metric
// per function, X-Ray epoch seconds and a filter on the unit's functions), continuation of a search
// that stopped early up to the page limit, the pinned region and attempts, failures recorded as
// unavailable telemetry, and the `telemetry_availability` record of a real lookup.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createAwsTelemetryProbe,
  TELEMETRY_PAGE_LIMIT,
} from '../../../src/evidence-collection/aws/aws-telemetry-probe.ts';
import type { TelemetryClientSettings } from '../../../src/evidence-collection/aws/aws-telemetry-probe.ts';
import { captureTelemetryAvailability } from '../../../src/evidence-collection/telemetry-availability.ts';
import type { TelemetryProbe } from '../../../src/evidence-collection/telemetry-availability.ts';
import type { TelemetryBinding } from '../../../src/evidence-collection/telemetry-targets.ts';
import {
  assertValidRecord,
  collectionClock,
  RUN_ID,
  TRIAL_ID,
  TRIAL_SCOPE,
} from '../../support/evidence-collection/collection-fixtures.ts';
import { ScriptedCloudWatchClient } from '../../support/evidence-collection/scripted-cloudwatch-client.ts';
import { ScriptedCloudWatchLogsClient } from '../../support/evidence-collection/scripted-cloudwatch-logs-client.ts';
import { ScriptedXRayClient } from '../../support/evidence-collection/scripted-xray-client.ts';
import {
  CONVENTIONAL_TRIAL_SCOPE,
  FUNCTION_NAMES,
  LOOKUP_MS,
  PROBE_BINDING,
  PROBE_EXECUTION_ID,
  PROBE_EXECUTION_SCOPE,
  RUN_BINDING,
  UNIT_STARTED_MS,
} from '../../support/evidence-collection/telemetry-fixtures.ts';

const PROVIDER_GROUP = `/suc/study-1/${RUN_ID}/refund-provider`;
const CALLER_GROUP = `/suc/study-1/${RUN_ID}/durable-caller`;
const CONTROLLER_GROUP = `/suc/study-1/${RUN_ID}/treatment-controller`;
const UNIT_FUNCTIONS = [
  FUNCTION_NAMES['durable-caller'],
  FUNCTION_NAMES['refund-provider'],
  FUNCTION_NAMES['treatment-controller'],
] as const;
const UNIT_TRACE_FILTER = UNIT_FUNCTIONS.map((name) => `service("${name}")`).join(' OR ');

interface ScriptedTelemetry {
  readonly logs: ScriptedCloudWatchLogsClient;
  readonly metrics: ScriptedCloudWatchClient;
  readonly traces: ScriptedXRayClient;
  readonly probe: TelemetryProbe;
}

function scriptedTelemetry(
  binding: TelemetryBinding = RUN_BINDING,
  settings: TelemetryClientSettings = {},
): ScriptedTelemetry {
  const logs = new ScriptedCloudWatchLogsClient(settings.logs);
  const metrics = new ScriptedCloudWatchClient(settings.metrics);
  const traces = new ScriptedXRayClient(settings.traces);
  for (const group of [CALLER_GROUP, PROVIDER_GROUP, CONTROLLER_GROUP]) {
    logs.createGroup(group);
  }
  const clients = { logs: logs.client, metrics: metrics.client, traces: traces.client };
  return { logs, metrics, traces, probe: createAwsTelemetryProbe({ clients, binding, clock: collectionClock() }) };
}

function lambdaInvocations(functionName: string): Parameters<ScriptedCloudWatchClient['putMetric']>[0] {
  return {
    Namespace: 'AWS/Lambda',
    MetricName: 'Invocations',
    Dimensions: [{ Name: 'FunctionName', Value: functionName }],
  };
}

describe('AWS telemetry probe: logs', () => {
  it('searches each log group of the unit once, for the quoted trial id inside the unit window', async () => {
    const telemetry = scriptedTelemetry();
    telemetry.logs.putEvent(PROVIDER_GROUP, {
      timestamp: UNIT_STARTED_MS + 1000,
      message: `{"trial_id":"${TRIAL_ID}"}`,
    });
    const located = await telemetry.probe.locate('logs', TRIAL_SCOPE);
    assert.deepEqual(located, { ok: true, value: [PROVIDER_GROUP] });
    assert.deepEqual(
      telemetry.logs.calls(),
      [CALLER_GROUP, PROVIDER_GROUP, CONTROLLER_GROUP].map((logGroupName) => ({
        operation: 'FilterLogEvents',
        input: {
          logGroupName,
          startTime: UNIT_STARTED_MS,
          endTime: LOOKUP_MS,
          filterPattern: `"${TRIAL_ID}"`,
          limit: 1,
        },
      })),
    );
  });

  it('finds nothing for an event of another trial or outside the window', async () => {
    const telemetry = scriptedTelemetry();
    telemetry.logs.putEvent(PROVIDER_GROUP, { timestamp: UNIT_STARTED_MS - 1, message: TRIAL_ID });
    telemetry.logs.putEvent(PROVIDER_GROUP, { timestamp: LOOKUP_MS + 1, message: TRIAL_ID });
    telemetry.logs.putEvent(CALLER_GROUP, { timestamp: UNIT_STARTED_MS, message: 'another trial' });
    assert.deepEqual(await telemetry.probe.locate('logs', TRIAL_SCOPE), { ok: true, value: [] });
  });

  it('keeps the groups found when another search failed, and reports the first failure otherwise', async () => {
    const telemetry = scriptedTelemetry();
    telemetry.logs.putEvent(CONTROLLER_GROUP, { timestamp: LOOKUP_MS, message: TRIAL_ID });
    telemetry.logs.scriptError('ThrottlingException');
    assert.deepEqual(await telemetry.probe.locate('logs', TRIAL_SCOPE), { ok: true, value: [CONTROLLER_GROUP] });
    const failing = scriptedTelemetry();
    failing.logs.scriptError('AccessDeniedException');
    failing.logs.stopSearchEarly(PROVIDER_GROUP);
    assert.deepEqual(await failing.probe.locate('logs', TRIAL_SCOPE), {
      ok: false,
      error: { code: 'AccessDeniedException' },
    });
  });

  it('reports a search that never finishes within the page limit as incomplete, not as nothing found', async () => {
    const telemetry = scriptedTelemetry();
    telemetry.logs.stopSearchEarly(CALLER_GROUP);
    assert.deepEqual(await telemetry.probe.locate('logs', TRIAL_SCOPE), {
      ok: false,
      error: { code: 'LogSearchIncomplete' },
    });
    const callerSearches = telemetry.logs.calls().filter((call) => call.input['logGroupName'] === CALLER_GROUP);
    assert.equal(TELEMETRY_PAGE_LIMIT, 10);
    assert.deepEqual(
      callerSearches.map((call) => call.input['nextToken']),
      [
        undefined,
        'scripted-next-2',
        'scripted-next-3',
        'scripted-next-4',
        'scripted-next-5',
        'scripted-next-6',
        'scripted-next-7',
        'scripted-next-8',
        'scripted-next-9',
        'scripted-next-10',
      ],
    );
  });

  it('follows the continuation token of a search that stopped early until it finds the event', async () => {
    const telemetry = scriptedTelemetry();
    telemetry.logs.putEvent(PROVIDER_GROUP, { timestamp: LOOKUP_MS, message: TRIAL_ID });
    telemetry.logs.stopSearchEarly(PROVIDER_GROUP, TELEMETRY_PAGE_LIMIT - 1);
    assert.deepEqual(await telemetry.probe.locate('logs', TRIAL_SCOPE), { ok: true, value: [PROVIDER_GROUP] });
    const providerSearches = telemetry.logs.calls().filter((call) => call.input['logGroupName'] === PROVIDER_GROUP);
    assert.equal(providerSearches.length, TELEMETRY_PAGE_LIMIT);
    assert.deepEqual(providerSearches.at(-1)?.input, {
      logGroupName: PROVIDER_GROUP,
      startTime: UNIT_STARTED_MS,
      endTime: LOOKUP_MS,
      filterPattern: `"${TRIAL_ID}"`,
      limit: 1,
      nextToken: `scripted-next-${String(TELEMETRY_PAGE_LIMIT)}`,
    });
  });

  it('stops at the page limit even when the event would be found on the next page', async () => {
    const telemetry = scriptedTelemetry();
    telemetry.logs.putEvent(PROVIDER_GROUP, { timestamp: LOOKUP_MS, message: TRIAL_ID });
    telemetry.logs.stopSearchEarly(PROVIDER_GROUP, TELEMETRY_PAGE_LIMIT);
    assert.deepEqual(await telemetry.probe.locate('logs', TRIAL_SCOPE), {
      ok: false,
      error: { code: 'LogSearchIncomplete' },
    });
  });

  it('fails a group the stack never created as ResourceNotFoundException', async () => {
    const telemetry = scriptedTelemetry(PROBE_BINDING);
    assert.deepEqual(await telemetry.probe.locate('logs', PROBE_EXECUTION_SCOPE), {
      ok: false,
      error: { code: 'ResourceNotFoundException' },
    });
  });

  it("correlates the probe unit by its transport-probe id in the probe execution's groups", async () => {
    const telemetry = scriptedTelemetry(PROBE_BINDING);
    const probeGroup = `/suc/study-1/${PROBE_EXECUTION_ID}/probe-caller`;
    telemetry.logs.putEvent(probeGroup, { timestamp: LOOKUP_MS, message: PROBE_EXECUTION_ID });
    telemetry.logs.createGroup(`/suc/study-1/${PROBE_EXECUTION_ID}/refund-provider`);
    telemetry.logs.createGroup(`/suc/study-1/${PROBE_EXECUTION_ID}/treatment-controller`);
    assert.deepEqual(await telemetry.probe.locate('logs', PROBE_EXECUTION_SCOPE), { ok: true, value: [probeGroup] });
    assert.deepEqual(
      telemetry.logs.calls().map((call) => call.input['filterPattern']),
      [`"${PROBE_EXECUTION_ID}"`, `"${PROBE_EXECUTION_ID}"`, `"${PROBE_EXECUTION_ID}"`],
    );
  });
});

describe('AWS telemetry probe: metrics', () => {
  it("lists the Lambda Invocations metric of each of the unit's functions", async () => {
    const telemetry = scriptedTelemetry();
    telemetry.metrics.putMetric(lambdaInvocations(FUNCTION_NAMES['refund-provider']));
    telemetry.metrics.putMetric(lambdaInvocations(FUNCTION_NAMES['conventional-caller']));
    assert.deepEqual(await telemetry.probe.locate('metrics', TRIAL_SCOPE), {
      ok: true,
      value: [`AWS/Lambda:Invocations:FunctionName=${FUNCTION_NAMES['refund-provider']}`],
    });
    assert.deepEqual(
      telemetry.metrics.calls(),
      UNIT_FUNCTIONS.map((Value) => ({
        operation: 'ListMetrics',
        input: { Namespace: 'AWS/Lambda', MetricName: 'Invocations', Dimensions: [{ Name: 'FunctionName', Value }] },
      })),
    );
  });

  it('reports a failed or stopped listing, and an unbound function without any call', async () => {
    const telemetry = scriptedTelemetry();
    telemetry.metrics.stopListingEarly();
    assert.deepEqual(await telemetry.probe.locate('metrics', TRIAL_SCOPE), {
      ok: false,
      error: { code: 'MetricListIncomplete' },
    });
    const failing = scriptedTelemetry();
    failing.metrics.scriptError('InvalidParameterValueException');
    assert.deepEqual(await failing.probe.locate('metrics', TRIAL_SCOPE), {
      ok: false,
      error: { code: 'InvalidParameterValueException' },
    });
    const { 'refund-provider': _dropped, ...unbound } = FUNCTION_NAMES;
    const missing = scriptedTelemetry({ ...RUN_BINDING, function_names: unbound });
    assert.deepEqual(await missing.probe.locate('metrics', TRIAL_SCOPE), {
      ok: false,
      error: { code: 'TelemetryFunctionUnbound' },
    });
    assert.deepEqual(missing.metrics.calls(), []);
  });
});

describe('AWS telemetry probe: traces', () => {
  it("searches trace summaries once over the unit window in epoch seconds, filtered to the unit's functions", async () => {
    const telemetry = scriptedTelemetry();
    assert.deepEqual(await telemetry.probe.locate('traces', TRIAL_SCOPE), { ok: true, value: [] });
    assert.deepEqual(telemetry.traces.calls(), [
      {
        operation: 'POST /TraceSummaries',
        input: { StartTime: UNIT_STARTED_MS / 1000, EndTime: LOOKUP_MS / 1000, FilterExpression: UNIT_TRACE_FILTER },
      },
    ]);
  });

  it("never records a trace of another workload in the account as the unit's trace", async () => {
    const telemetry = scriptedTelemetry();
    telemetry.traces.putTrace({ id: '1-elsewhere', started_ms: UNIT_STARTED_MS, services: ['another-workload'] });
    telemetry.traces.putTrace({
      id: '1-conventional',
      started_ms: UNIT_STARTED_MS,
      services: [FUNCTION_NAMES['conventional-caller']],
    });
    assert.deepEqual(await telemetry.probe.locate('traces', TRIAL_SCOPE), { ok: true, value: [] });
  });

  it('refuses a trace search for a unit whose function is unbound or misnamed, without a request', async () => {
    const { 'treatment-controller': _dropped, ...unbound } = FUNCTION_NAMES;
    const missing = scriptedTelemetry({ ...RUN_BINDING, function_names: unbound });
    assert.deepEqual(await missing.probe.locate('traces', TRIAL_SCOPE), {
      ok: false,
      error: { code: 'TelemetryFunctionUnbound' },
    });
    const misnamed = scriptedTelemetry({
      ...RUN_BINDING,
      function_names: { ...FUNCTION_NAMES, 'refund-provider': 'fn") OR service("x' },
    });
    assert.deepEqual(await misnamed.probe.locate('traces', TRIAL_SCOPE), {
      ok: false,
      error: { code: 'TelemetryFunctionNameInvalid' },
    });
    assert.deepEqual([...missing.traces.calls(), ...misnamed.traces.calls()], []);
  });

  it('follows the continuation token of a trace search that stopped early', async () => {
    const telemetry = scriptedTelemetry();
    const traceId = '1-6702a0b4-0123456789abcdef01234567';
    telemetry.traces.putTrace({ id: traceId, started_ms: LOOKUP_MS, services: [FUNCTION_NAMES['refund-provider']] });
    telemetry.traces.stopSearchEarly(2);
    assert.deepEqual(await telemetry.probe.locate('traces', TRIAL_SCOPE), { ok: true, value: [traceId] });
    assert.deepEqual(
      telemetry.traces.calls().map((call) => call.input['NextToken']),
      [undefined, 'scripted-next-2', 'scripted-next-3'],
    );
  });

  it('lists the trace ids found, and reports a failed or stopped search', async () => {
    const telemetry = scriptedTelemetry();
    telemetry.traces.putTrace({
      id: '1-6702a0b4-0123456789abcdef01234567',
      started_ms: UNIT_STARTED_MS,
      services: [FUNCTION_NAMES['durable-caller']],
    });
    assert.deepEqual(await telemetry.probe.locate('traces', TRIAL_SCOPE), {
      ok: true,
      value: ['1-6702a0b4-0123456789abcdef01234567'],
    });
    telemetry.traces.scriptError('ThrottledException', 429);
    assert.deepEqual(await telemetry.probe.locate('traces', TRIAL_SCOPE), {
      ok: false,
      error: { code: 'ThrottledException' },
    });
    telemetry.traces.stopSearchEarly();
    assert.deepEqual(await telemetry.probe.locate('traces', TRIAL_SCOPE), {
      ok: false,
      error: { code: 'TraceSearchIncomplete' },
    });
  });
});

describe('AWS telemetry probe: binding', () => {
  it('refuses a unit of another execution or with no start instant without sending a request', async () => {
    const telemetry = scriptedTelemetry(PROBE_BINDING);
    assert.deepEqual(await telemetry.probe.locate('logs', TRIAL_SCOPE), {
      ok: false,
      error: { code: 'TelemetryExecutionUnbound' },
    });
    const notStarted = scriptedTelemetry();
    assert.deepEqual(await notStarted.probe.locate('traces', CONVENTIONAL_TRIAL_SCOPE), {
      ok: false,
      error: { code: 'TelemetryWindowUnknown' },
    });
    assert.deepEqual([...telemetry.logs.calls(), ...notStarted.traces.calls()], []);
  });

  it('keeps us-east-1 and a single attempt even when a cast smuggles other values in', async () => {
    const smuggled = { region: 'eu-west-1', maxAttempts: 5, retryMode: 'adaptive' } as unknown as Record<string, never>;
    const telemetry = scriptedTelemetry(RUN_BINDING, { logs: smuggled, metrics: smuggled, traces: smuggled });
    for (const client of [telemetry.logs.client, telemetry.metrics.client, telemetry.traces.client]) {
      assert.equal(await client.config.region(), 'us-east-1');
      assert.equal(await client.config.maxAttempts(), 1);
      const retryMode = client.config.retryMode;
      assert.equal(typeof retryMode === 'string' ? retryMode : await retryMode(), 'standard');
    }
    telemetry.logs.scriptError('ThrottlingException');
    telemetry.logs.scriptError('ThrottlingException');
    telemetry.logs.scriptError('ThrottlingException');
    assert.deepEqual(await telemetry.probe.locate('logs', TRIAL_SCOPE), {
      ok: false,
      error: { code: 'ThrottlingException' },
    });
    assert.equal(telemetry.logs.calls().length, 3, 'one request per group, none retried');
  });
});

describe('telemetry availability of a real lookup (AC-RUA-054)', () => {
  it('records logs and metrics available and traces unavailable as the deployment leaves them', async () => {
    const telemetry = scriptedTelemetry();
    telemetry.logs.putEvent(CALLER_GROUP, { timestamp: UNIT_STARTED_MS, message: TRIAL_ID });
    telemetry.logs.putEvent(PROVIDER_GROUP, { timestamp: LOOKUP_MS, message: TRIAL_ID });
    for (const functionName of UNIT_FUNCTIONS) {
      telemetry.metrics.putMetric(lambdaInvocations(functionName));
    }
    const record = await captureTelemetryAvailability(telemetry.probe, TRIAL_SCOPE, collectionClock());
    assertValidRecord(record, 'telemetry_availability');
    assert.deepEqual(record['logs'], {
      availability: 'available',
      locators: [CALLER_GROUP, PROVIDER_GROUP],
      reasons: [],
    });
    assert.deepEqual(record['metrics'], {
      availability: 'available',
      locators: UNIT_FUNCTIONS.map((name) => `AWS/Lambda:Invocations:FunctionName=${name}`),
      reasons: [],
    });
    assert.deepEqual(record['traces'], {
      availability: 'unavailable',
      locators: [],
      reasons: [
        {
          code: 'TELEMETRY_NOT_FOUND',
          subject: 'BR-RUA-037',
          detail: 'traces lookup found no locator; expected at least one',
        },
      ],
    });
  });

  it('records a failed lookup as unavailable with its error, never failing the record', async () => {
    const telemetry = scriptedTelemetry();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      telemetry.logs.scriptError('AccessDeniedException');
    }
    telemetry.metrics.stopListingEarly();
    const record = await captureTelemetryAvailability(telemetry.probe, TRIAL_SCOPE, collectionClock());
    assertValidRecord(record, 'telemetry_availability');
    assert.deepEqual(record['logs'], {
      availability: 'unavailable',
      locators: [],
      reasons: [
        {
          code: 'TELEMETRY_UNAVAILABLE',
          subject: 'BR-RUA-037',
          detail: 'logs could not be located: AccessDeniedException; expected a successful lookup',
        },
      ],
    });
    assert.equal((record['metrics'] as { availability: string }).availability, 'unavailable');
  });
});
