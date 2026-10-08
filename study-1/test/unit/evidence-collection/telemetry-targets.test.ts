// Telemetry targets of a capture unit and the mapping of lookup outputs to locators (BR-RUA-037,
// AC-RUA-054; design §9.4, §9.7, A-13). Exact log groups, windows, filter patterns, trace filter
// expressions and locators, every refusal code, the incomplete-page rule and search continuation.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  combineLookups,
  logFilterPattern,
  logLookupOutcome,
  metricLocator,
  metricLookupOutcome,
  searchContinuation,
  telemetryUnit,
  telemetryWindow,
  traceFilterExpression,
  traceLocators,
  unitFunctionNames,
  unitLogGroups,
} from '../../../src/evidence-collection/telemetry-targets.ts';
import type { TelemetryUnit } from '../../../src/evidence-collection/telemetry-targets.ts';
import { RUN_ID, TRIAL_ID, TRIAL_SCOPE } from '../../support/evidence-collection/collection-fixtures.ts';
import {
  bindingStartingAt,
  CONVENTIONAL_TRIAL_ID,
  CONVENTIONAL_TRIAL_SCOPE,
  FUNCTION_NAMES,
  LOOKUP_MS,
  PROBE_BINDING,
  PROBE_EXECUTION_ID,
  PROBE_EXECUTION_SCOPE,
  RUN_BINDING,
  UNDECLARED_TRIAL_ID,
  UNIT_STARTED_MS,
} from '../../support/evidence-collection/telemetry-fixtures.ts';

const DURABLE_UNIT: TelemetryUnit = {
  correlation_id: TRIAL_ID,
  unit_key: TRIAL_ID,
  roles: ['durable-caller', 'refund-provider', 'treatment-controller'],
};
const FUNCTION = FUNCTION_NAMES['refund-provider'];
const INVOCATIONS = {
  Namespace: 'AWS/Lambda',
  MetricName: 'Invocations',
  Dimensions: [{ Name: 'FunctionName', Value: FUNCTION }],
};

describe('telemetryUnit', () => {
  it('binds a trial to its variant caller, the provider and the controller', () => {
    assert.deepEqual(telemetryUnit(RUN_BINDING, TRIAL_SCOPE), { ok: true, value: DURABLE_UNIT });
    assert.deepEqual(telemetryUnit(RUN_BINDING, CONVENTIONAL_TRIAL_SCOPE), {
      ok: true,
      value: {
        correlation_id: CONVENTIONAL_TRIAL_ID,
        unit_key: CONVENTIONAL_TRIAL_ID,
        roles: ['conventional-caller', 'refund-provider', 'treatment-controller'],
      },
    });
  });

  it('binds the probe to the probe caller and correlates it by the transport-probe id', () => {
    assert.deepEqual(telemetryUnit(PROBE_BINDING, PROBE_EXECUTION_SCOPE), {
      ok: true,
      value: {
        correlation_id: PROBE_EXECUTION_ID,
        unit_key: 'probe',
        roles: ['probe-caller', 'refund-provider', 'treatment-controller'],
      },
    });
  });

  it('refuses a unit of another execution or an undeclared trial', () => {
    assert.deepEqual(telemetryUnit(PROBE_BINDING, TRIAL_SCOPE), {
      ok: false,
      error: { code: 'TelemetryExecutionUnbound' },
    });
    const undeclared = { ...TRIAL_SCOPE, unit: { ...TRIAL_SCOPE.unit, trial_id: UNDECLARED_TRIAL_ID } };
    assert.deepEqual(telemetryUnit(RUN_BINDING, undeclared), { ok: false, error: { code: 'TelemetryTrialUnbound' } });
  });
});

describe('telemetryWindow', () => {
  it('runs from the unit start to the lookup instant, both included', () => {
    assert.deepEqual(telemetryWindow(RUN_BINDING, DURABLE_UNIT, new Date(LOOKUP_MS)), {
      ok: true,
      value: { start_ms: UNIT_STARTED_MS, end_ms: LOOKUP_MS },
    });
    assert.deepEqual(telemetryWindow(RUN_BINDING, DURABLE_UNIT, new Date(UNIT_STARTED_MS)), {
      ok: true,
      value: { start_ms: UNIT_STARTED_MS, end_ms: UNIT_STARTED_MS },
    });
  });

  it('refuses a unit with no readable start or one that starts after the lookup', () => {
    const conventional = { ...DURABLE_UNIT, unit_key: CONVENTIONAL_TRIAL_ID };
    assert.deepEqual(telemetryWindow(RUN_BINDING, conventional, new Date(LOOKUP_MS)), {
      ok: false,
      error: { code: 'TelemetryWindowUnknown' },
    });
    assert.deepEqual(telemetryWindow(bindingStartingAt({ [TRIAL_ID]: 'soon' }), DURABLE_UNIT, new Date(LOOKUP_MS)), {
      ok: false,
      error: { code: 'TelemetryWindowUnknown' },
    });
    assert.deepEqual(telemetryWindow(RUN_BINDING, DURABLE_UNIT, new Date(UNIT_STARTED_MS - 1)), {
      ok: false,
      error: { code: 'TelemetryWindowInverted' },
    });
  });
});

describe('unit log groups and function names', () => {
  it('names the stack-owned log group of each function (A-13)', () => {
    assert.deepEqual(unitLogGroups(RUN_BINDING, DURABLE_UNIT), [
      `/suc/study-1/${RUN_ID}/durable-caller`,
      `/suc/study-1/${RUN_ID}/refund-provider`,
      `/suc/study-1/${RUN_ID}/treatment-controller`,
    ]);
  });

  it('gives the deployed function names in role order', () => {
    assert.deepEqual(unitFunctionNames(RUN_BINDING, DURABLE_UNIT), {
      ok: true,
      value: [
        FUNCTION_NAMES['durable-caller'],
        FUNCTION_NAMES['refund-provider'],
        FUNCTION_NAMES['treatment-controller'],
      ],
    });
  });

  it('refuses a missing, empty or inherited function name', () => {
    const unbound = { code: 'TelemetryFunctionUnbound' };
    const { 'durable-caller': _dropped, ...withoutCaller } = FUNCTION_NAMES;
    for (const functionNames of [
      withoutCaller,
      { ...FUNCTION_NAMES, 'treatment-controller': '' },
      Object.create(FUNCTION_NAMES) as object,
    ]) {
      assert.deepEqual(unitFunctionNames({ ...RUN_BINDING, function_names: functionNames }, DURABLE_UNIT), {
        ok: false,
        error: unbound,
      });
    }
  });

  it('quotes the correlation id as a filter term', () => {
    assert.equal(logFilterPattern(TRIAL_ID), `"${TRIAL_ID}"`);
  });
});

describe('logLookupOutcome', () => {
  const group = `/suc/study-1/${RUN_ID}/refund-provider`;

  it('locates the group when the search returned an event', () => {
    assert.deepEqual(logLookupOutcome(group, { events: [{ message: TRIAL_ID }] }), { ok: true, value: group });
    assert.deepEqual(logLookupOutcome(group, { events: [{}], nextToken: 't' }), { ok: true, value: group });
  });

  it('finds nothing when the search finished empty, and is incomplete when it stopped with a token', () => {
    assert.deepEqual(logLookupOutcome(group, { events: [] }), { ok: true, value: undefined });
    assert.deepEqual(logLookupOutcome(group, { nextToken: '' }), { ok: true, value: undefined });
    assert.deepEqual(logLookupOutcome(group, { events: [], nextToken: 'next' }), {
      ok: false,
      error: { code: 'LogSearchIncomplete' },
    });
  });

  it('reads only own members of a well-formed output', () => {
    assert.deepEqual(logLookupOutcome(group, undefined), { ok: true, value: undefined });
    assert.deepEqual(logLookupOutcome(group, { events: { length: 1 } }), { ok: true, value: undefined });
    assert.deepEqual(logLookupOutcome(group, Object.create({ events: [{}] })), { ok: true, value: undefined });
  });

  it('never descends into an event, so 100,000-level nesting or a non-finite value is just an event (A-05)', () => {
    let nested: unknown = Number.POSITIVE_INFINITY;
    for (let depth = 0; depth < 100_000; depth += 1) {
      nested = [nested];
    }
    assert.deepEqual(logLookupOutcome(group, { events: [nested] }), { ok: true, value: group });
    assert.deepEqual(traceLocators({ TraceSummaries: [{ Id: Number.POSITIVE_INFINITY }, nested] }), {
      ok: true,
      value: [],
    });
  });
});

describe('metricLookupOutcome', () => {
  it("locates the function's Invocations metric", () => {
    assert.equal(metricLocator(FUNCTION), `AWS/Lambda:Invocations:FunctionName=${FUNCTION}`);
    assert.deepEqual(metricLookupOutcome(FUNCTION, { Metrics: [INVOCATIONS] }), {
      ok: true,
      value: metricLocator(FUNCTION),
    });
    assert.deepEqual(metricLookupOutcome(FUNCTION, { Metrics: [{}, INVOCATIONS], NextToken: 'n' }), {
      ok: true,
      value: metricLocator(FUNCTION),
    });
  });

  it('ignores a metric of another namespace, name, dimension or function', () => {
    const others = [
      { ...INVOCATIONS, Namespace: 'AWS/SQS' },
      { ...INVOCATIONS, MetricName: 'Errors' },
      { ...INVOCATIONS, Dimensions: [{ Name: 'Resource', Value: FUNCTION }] },
      { ...INVOCATIONS, Dimensions: [{ Name: 'FunctionName', Value: 'other' }] },
      { Namespace: 'AWS/Lambda', MetricName: 'Invocations' },
    ];
    for (const metric of others) {
      assert.deepEqual(metricLookupOutcome(FUNCTION, { Metrics: [metric] }), { ok: true, value: undefined });
    }
    assert.deepEqual(metricLookupOutcome(FUNCTION, { Metrics: others, NextToken: 'n' }), {
      ok: false,
      error: { code: 'MetricListIncomplete' },
    });
  });
});

describe('traceLocators', () => {
  it('lists each non-empty trace id once', () => {
    const output = { TraceSummaries: [{ Id: '1-a' }, { Id: '' }, { Id: 7 }, {}, { Id: '1-a' }, { Id: '1-b' }] };
    assert.deepEqual(traceLocators(output), { ok: true, value: ['1-a', '1-b'] });
    assert.deepEqual(traceLocators({ TraceSummaries: [{ Id: '1-a' }], NextToken: 'n' }), { ok: true, value: ['1-a'] });
  });

  it('finds none when the search finished empty, and is incomplete when it stopped with a token', () => {
    assert.deepEqual(traceLocators({}), { ok: true, value: [] });
    assert.deepEqual(traceLocators(null), { ok: true, value: [] });
    assert.deepEqual(traceLocators({ TraceSummaries: [], NextToken: 'n' }), {
      ok: false,
      error: { code: 'TraceSearchIncomplete' },
    });
  });
});

describe('traceFilterExpression', () => {
  it("joins one service term per function with OR, so only the unit's traces match", () => {
    assert.deepEqual(traceFilterExpression(['fn-a']), { ok: true, value: 'service("fn-a")' });
    assert.deepEqual(traceFilterExpression([FUNCTION, 'Fn_2-b']), {
      ok: true,
      value: `service("${FUNCTION}") OR service("Fn_2-b")`,
    });
    assert.deepEqual(traceFilterExpression(['a'.repeat(64)]), { ok: true, value: `service("${'a'.repeat(64)}")` });
  });

  it('refuses no function, and any name a Lambda function cannot have, rather than widen the search', () => {
    for (const names of [[], [''], ['fn a'], ['fn"a'], ['fn") OR service("x'], ['a'.repeat(65)], ['fn-a', 'é']]) {
      assert.deepEqual(traceFilterExpression(names), { ok: false, error: { code: 'TelemetryFunctionNameInvalid' } });
    }
  });
});

describe('searchContinuation', () => {
  const incomplete = { ok: false, error: { code: 'LogSearchIncomplete' } } as const;

  it("continues an incomplete search with the output's own non-empty token", () => {
    assert.equal(searchContinuation(incomplete, { nextToken: 't-2' }, 'nextToken'), 't-2');
    assert.equal(searchContinuation(incomplete, { NextToken: 'T-2' }, 'NextToken'), 'T-2');
  });

  it('stops a search that found its answer, or one with no usable token', () => {
    assert.equal(searchContinuation({ ok: true, value: 'g' }, { nextToken: 't-2' }, 'nextToken'), undefined);
    assert.equal(searchContinuation(incomplete, { nextToken: '' }, 'nextToken'), undefined);
    assert.equal(searchContinuation(incomplete, { nextToken: 7 }, 'nextToken'), undefined);
    assert.equal(searchContinuation(incomplete, { NextToken: 't-2' }, 'nextToken'), undefined);
    assert.equal(searchContinuation(incomplete, Object.create({ nextToken: 't-2' }), 'nextToken'), undefined);
    assert.equal(searchContinuation(incomplete, undefined, 'nextToken'), undefined);
  });
});

describe('combineLookups', () => {
  const throttled = { ok: false, error: { code: 'ThrottlingException' } } as const;
  const denied = { ok: false, error: { code: 'AccessDeniedException' } } as const;

  it('keeps every locator found, even when another lookup failed', () => {
    assert.deepEqual(
      combineLookups([throttled, { ok: true, value: 'g1' }, { ok: true, value: undefined }, { ok: true, value: 'g2' }]),
      {
        ok: true,
        value: ['g1', 'g2'],
      },
    );
  });

  it('reports the first failure when nothing was found, and nothing found otherwise', () => {
    assert.deepEqual(combineLookups([{ ok: true, value: undefined }, denied, throttled]), denied);
    assert.deepEqual(combineLookups([{ ok: true, value: undefined }]), { ok: true, value: [] });
    assert.deepEqual(combineLookups([]), { ok: true, value: [] });
  });
});
