// Design §12.5 for the telemetry targets (BR-RUA-037, AC-RUA-054; design §9.4; A-05): over
// arbitrary bindings and scopes, a unit is bound exactly when its execution and trial are declared,
// its log groups are the execution's stack-owned groups of its roles, its window is the declared
// start to the lookup instant, and its function names resolve exactly when every role has an own
// non-empty name. Over arbitrary service outputs (wrong types, inherited members), each output
// maps to locators exactly as an independent model of the page rule says, an incomplete search
// continues exactly with an own non-empty token, a trace filter is built exactly from valid Lambda
// function names, and the lookups combine by the found-first, then first-failure law. Nothing throws.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { CaptureScope } from '../../../src/evidence-collection/capture-scope.ts';
import {
  combineLookups,
  logLookupOutcome,
  metricLocator,
  metricLookupOutcome,
  searchContinuation,
  TELEMETRY_FUNCTION_ROLES,
  telemetryUnit,
  telemetryWindow,
  traceFilterExpression,
  traceLocators,
  unitFunctionNames,
  unitLogGroups,
} from '../../../src/evidence-collection/telemetry-targets.ts';
import type { LookupOutcome, TelemetryBinding } from '../../../src/evidence-collection/telemetry-targets.ts';
import type { UtcMillis, Uuid4, VariantId } from '../../../src/record-contract/primitives.ts';
import { TRIAL_SCOPE } from '../../support/evidence-collection/collection-fixtures.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const IDS = [
  '00000000-0000-4000-8000-000000000301',
  '00000000-0000-4000-8000-000000000302',
  '00000000-0000-4000-8000-000000000303',
] as Uuid4[];
const FUNCTION = 'SucRua-run-RefundProviderFn';
const MIN_MS = Date.UTC(2026, 0, 1);
const MAX_MS = Date.UTC(2027, 0, 1);
const LAMBDA_NAME_CHARACTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';

const variant = fc.constantFrom<VariantId>('durable', 'conventional');
const instant = fc.integer({ min: MIN_MS, max: MAX_MS });
const binding: fc.Arbitrary<TelemetryBinding> = fc.record({
  execution_id: fc.constantFrom(...IDS),
  function_names: fc.dictionary(fc.constantFrom(...TELEMETRY_FUNCTION_ROLES), fc.constantFrom('', 'fn-a', 'fn-b')),
  trial_variants: fc.array(fc.tuple(fc.constantFrom(...IDS), variant), { maxLength: 3 }).map((pairs) => new Map(pairs)),
  unit_started_at: fc
    .array(
      fc.tuple(
        fc.constantFrom<string>('probe', ...IDS),
        fc.oneof(
          instant.map((ms) => new Date(ms).toISOString()),
          fc.constantFrom('not-an-instant', ''),
        ),
      ),
      { maxLength: 4 },
    )
    .map((pairs) => new Map(pairs as [string, UtcMillis][])),
});

const scope: fc.Arbitrary<CaptureScope> = fc.oneof(
  fc.record({ run: fc.constantFrom(...IDS), trial: fc.constantFrom(...IDS) }).map(({ run, trial }) => ({
    ...TRIAL_SCOPE,
    execution: { execution_kind: 'RUN', run_id: run },
    unit: { ...TRIAL_SCOPE.unit, trial_id: trial },
  })),
  fc.constantFrom(...IDS).map((probe) => ({
    execution: { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: probe },
    execution_manifest_sha256: TRIAL_SCOPE.execution_manifest_sha256,
    unit: { kind: 'probe' },
  })),
) as fc.Arbitrary<CaptureScope>;

// Values a service output may hold where a list, token or string is expected.
const loose = fc.oneof(fc.constantFrom(undefined, null, '', 'tok', 0, true), fc.jsonValue({ maxDepth: 1 }));
const wellFormedMetric = fc.record({
  Namespace: fc.constantFrom('AWS/Lambda', 'AWS/SQS'),
  MetricName: fc.constantFrom('Invocations', 'Errors'),
  Dimensions: fc.array(
    fc.record({ Name: fc.constantFrom('FunctionName', 'Resource'), Value: fc.constantFrom(FUNCTION, 'other') }),
    { maxLength: 2 },
  ),
});

function withInherited(own: fc.Arbitrary<Record<string, unknown>>): fc.Arbitrary<unknown> {
  return fc.oneof(
    { weight: 4, arbitrary: own },
    { weight: 1, arbitrary: own.map((members) => Object.create(members) as object) },
    { weight: 1, arbitrary: loose },
  );
}

function ownOf(holder: unknown, key: string): unknown {
  return typeof holder === 'object' && holder !== null && Object.hasOwn(holder, key)
    ? (holder as Record<string, unknown>)[key]
    : undefined;
}

function tokenOf(holder: unknown, key: string): boolean {
  const token = ownOf(holder, key);
  return typeof token === 'string' && token !== '';
}

// The model of a Lambda function name (Lambda API reference, FunctionName): 1 to 64 letters,
// digits, hyphens or underscores, checked one UTF-16 unit at a time.
function isLambdaFunctionName(candidate: string): boolean {
  if (candidate.length < 1 || candidate.length > 64) {
    return false;
  }
  for (let index = 0; index < candidate.length; index += 1) {
    if (!LAMBDA_NAME_CHARACTERS.includes(candidate.charAt(index))) {
      return false;
    }
  }
  return true;
}

function listOfOwn(holder: unknown, key: string): readonly unknown[] {
  const list = ownOf(holder, key);
  return Array.isArray(list) ? list : [];
}

describe('telemetry unit targets', () => {
  it('binds a declared unit to its roles, groups, window and names, and refuses any other', () => {
    fc.assert(
      fc.property(binding, scope, instant, (bound, unitScope, nowMs) => {
        const unit = telemetryUnit(bound, unitScope);
        const execution = unitScope.execution.execution_kind === 'RUN' ? unitScope.execution.run_id : undefined;
        const executionId = execution ?? (unitScope.execution as { transport_probe_id: Uuid4 }).transport_probe_id;
        const trialId = unitScope.unit.kind === 'trial' ? unitScope.unit.trial_id : undefined;
        if (executionId !== bound.execution_id) {
          assert.deepEqual(unit, { ok: false, error: { code: 'TelemetryExecutionUnbound' } });
          return;
        }
        const declared = trialId === undefined ? 'probe' : bound.trial_variants.get(trialId);
        if (declared === undefined) {
          assert.deepEqual(unit, { ok: false, error: { code: 'TelemetryTrialUnbound' } });
          return;
        }
        assert.ok(unit.ok);
        const caller = trialId === undefined ? 'probe-caller' : `${declared}-caller`;
        assert.deepEqual(unit.value.roles, [caller, 'refund-provider', 'treatment-controller']);
        assert.equal(unit.value.correlation_id, trialId ?? executionId);
        assert.deepEqual(
          unitLogGroups(bound, unit.value),
          unit.value.roles.map((role) => `/suc/study-1/${bound.execution_id}/${role}`),
        );
        const names = unit.value.roles.map((role) => ownOf(bound.function_names, role));
        const named = names.every((name) => typeof name === 'string' && name !== '');
        assert.deepEqual(
          unitFunctionNames(bound, unit.value),
          named ? { ok: true, value: names } : { ok: false, error: { code: 'TelemetryFunctionUnbound' } },
        );
        const started = bound.unit_started_at.get(unit.value.unit_key);
        const startMs = started === undefined ? Number.NaN : Date.parse(started);
        const window = telemetryWindow(bound, unit.value, new Date(nowMs));
        if (Number.isNaN(startMs)) {
          assert.deepEqual(window, { ok: false, error: { code: 'TelemetryWindowUnknown' } });
          return;
        }
        assert.deepEqual(
          window,
          startMs <= nowMs
            ? { ok: true, value: { start_ms: startMs, end_ms: nowMs } }
            : { ok: false, error: { code: 'TelemetryWindowInverted' } },
        );
      }),
      fuzzParameters(),
    );
  });
});

describe('telemetry locator mapping', () => {
  it('maps a FilterLogEvents page by the found, incomplete or nothing-found rule', () => {
    const page = withInherited(
      fc.record({ events: fc.oneof(fc.array(loose, { maxLength: 2 }), loose), nextToken: loose }),
    );
    fc.assert(
      fc.property(page, (output) => {
        const found = listOfOwn(output, 'events').length > 0;
        const expected: LookupOutcome = found
          ? { ok: true, value: '/g' }
          : tokenOf(output, 'nextToken')
            ? { ok: false, error: { code: 'LogSearchIncomplete' } }
            : { ok: true, value: undefined };
        assert.deepEqual(logLookupOutcome('/g', output), expected);
      }),
      fuzzParameters(),
    );
  });

  it("maps a ListMetrics page to the function's Invocations locator only from an exact own match", () => {
    const metric = withInherited(wellFormedMetric);
    const page = withInherited(
      fc.record({ Metrics: fc.oneof(fc.array(metric, { maxLength: 3 }), loose), NextToken: loose }),
    );
    fc.assert(
      fc.property(page, (output) => {
        const found = listOfOwn(output, 'Metrics').some(
          (item) =>
            ownOf(item, 'Namespace') === 'AWS/Lambda' &&
            ownOf(item, 'MetricName') === 'Invocations' &&
            listOfOwn(item, 'Dimensions').some(
              (dimension) => ownOf(dimension, 'Name') === 'FunctionName' && ownOf(dimension, 'Value') === FUNCTION,
            ),
        );
        const expected: LookupOutcome = found
          ? { ok: true, value: metricLocator(FUNCTION) }
          : tokenOf(output, 'NextToken')
            ? { ok: false, error: { code: 'MetricListIncomplete' } }
            : { ok: true, value: undefined };
        assert.deepEqual(metricLookupOutcome(FUNCTION, output), expected);
      }),
      fuzzParameters(),
    );
  });

  it('maps a GetTraceSummaries page to its distinct non-empty own trace ids in order', () => {
    const summary = withInherited(fc.record({ Id: fc.oneof(fc.constantFrom('1-a', '1-b', ''), loose) }));
    const page = withInherited(
      fc.record({ TraceSummaries: fc.oneof(fc.array(summary, { maxLength: 4 }), loose), NextToken: loose }),
    );
    fc.assert(
      fc.property(page, (output) => {
        const ids = listOfOwn(output, 'TraceSummaries')
          .map((item) => ownOf(item, 'Id'))
          .filter((id): id is string => typeof id === 'string' && id !== '');
        const located = traceLocators(output);
        if (ids.length === 0 && tokenOf(output, 'NextToken')) {
          assert.deepEqual(located, { ok: false, error: { code: 'TraceSearchIncomplete' } });
          return;
        }
        assert.deepEqual(located, { ok: true, value: [...new Set(ids)] });
      }),
      fuzzParameters(),
    );
  });

  it('continues a search exactly when it is incomplete and its output holds an own non-empty token', () => {
    const outcome: fc.Arbitrary<LookupOutcome> = fc.oneof(
      fc.constantFrom('g1', undefined).map((value) => ({ ok: true as const, value })),
      fc.constant({ ok: false as const, error: { code: 'LogSearchIncomplete' } }),
    );
    const output = withInherited(fc.record({ nextToken: loose, NextToken: loose }, { requiredKeys: [] }));
    fc.assert(
      fc.property(outcome, output, fc.constantFrom('nextToken', 'NextToken'), (searched, page, member) => {
        const expected = !searched.ok && tokenOf(page, member) ? ownOf(page, member) : undefined;
        assert.equal(searchContinuation(searched, page, member), expected);
      }),
      fuzzParameters(),
    );
  });

  it('builds a trace filter of OR-joined service terms exactly from valid Lambda function names', () => {
    const nameChar = fc.oneof(
      { weight: 9, arbitrary: fc.constantFrom('a', 'Z', '0', '9', '_', '-') },
      { weight: 1, arbitrary: fc.constantFrom('"', ' ', ')', '\\', 'é', '\n') },
    );
    const name = fc.oneof(
      fc.array(nameChar, { maxLength: 6 }).map((chars) => chars.join('')),
      fc.integer({ min: 63, max: 66 }).map((length) => 'f'.repeat(length)),
    );
    fc.assert(
      fc.property(fc.array(name, { maxLength: 4 }), (names) => {
        const valid = names.length > 0 && names.every(isLambdaFunctionName);
        const expected = valid
          ? { ok: true, value: names.map((candidate) => 'service("' + candidate + '")').join(' OR ') }
          : { ok: false, error: { code: 'TelemetryFunctionNameInvalid' } };
        assert.deepEqual(traceFilterExpression(names), expected);
      }),
      fuzzParameters(),
    );
  });

  it('combines lookups: every locator found, else the first failure, else none', () => {
    const outcome: fc.Arbitrary<LookupOutcome> = fc.oneof(
      fc.constantFrom('g1', 'g2', undefined).map((value) => ({ ok: true as const, value })),
      fc
        .constantFrom('ThrottlingException', 'AccessDeniedException')
        .map((code) => ({ ok: false as const, error: { code } })),
    );
    fc.assert(
      fc.property(fc.array(outcome, { maxLength: 6 }), (outcomes) => {
        const found = outcomes.flatMap((item) => (item.ok && item.value !== undefined ? [item.value] : []));
        const failure = outcomes.find((item) => !item.ok);
        const combined = combineLookups(outcomes);
        assert.deepEqual(combined, found.length > 0 || failure === undefined ? { ok: true, value: found } : failure);
      }),
      fuzzParameters(),
    );
  });
});
