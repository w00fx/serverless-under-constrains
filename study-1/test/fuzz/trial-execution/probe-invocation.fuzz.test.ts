// Property targets `lambdaInvokeResponseOf` and `judgeProbeInvocation` (BR-RUA-027, AC-RUA-053,
// D-29, Owner amendment A-05, design §12.5): the Lambda Invoke output of the probe caller, its
// status, version, function error, payload and request id, and whatever the Invoke threw, are
// untrusted. Over arbitrary outputs and thrown values, including throwing getters, throwing proxies
// and inherited members, the mapping is total and reads own members only, and the judge agrees with
// a reference model written from the module's rule:
// - a rejection starts no probe;
// - no response, a status outside the integers 100..599 or no request id starts the probe without
//   a recorded invocation (returned unless nothing answered);
// - otherwise the invocation is recorded as answered, with a version mismatch, a failed workload
//   (a status other than 200 or a function error) or else a report other than this probe's as
//   diagnostics.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import type { ProbeWorkloadRequest } from '../../../src/record-contract/records/group-a/probe_workload_request.ts';
import {
  judgeProbeInvocation,
  lambdaInvokeResponseOf,
  probeInvokeFailureOf,
} from '../../../src/trial-execution/probe-invocation.ts';
import type { LambdaInvokeResponse, ProbeInvocationJudgement } from '../../../src/trial-execution/probe-invocation.ts';
import type { ProbeWorkloadInvokeResult } from '../../../src/trial-execution/trial-execution-ports.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { MANIFEST_SHA } from '../../unit/trial-execution/support/trial-execution-fixtures.ts';
import { anyValue, inheriting, throwingProxy, withThrowingMember } from './support/hostile-values.ts';

const PROBE_ID = '2559d5f6-ec95-4777-a74e-452fcfde7526';
const VERSION = '1';
const PLAN = {
  request: {
    schema_version: 1,
    record_type: 'probe_workload_request',
    transport_probe_id: PROBE_ID,
    execution_manifest_sha256: MANIFEST_SHA,
    payment_id: 'pay-poc-001',
    refund_request_id: 'ref-poc-001',
    amount_minor: 10000,
    currency: 'BRL',
  } as ProbeWorkloadRequest,
  probe_caller_version: VERSION,
};
const REQUEST_IDS = ['req-1', 'req-2', ''];
const REPORT_KEYS: ReadonlySet<string> = new Set(['transport_probe_id', 'lambda_request_id', '__proto__']);
// Every diagnostic quotes untrusted text through the kernel's bounded renderers.
const DETAIL_BOUND = 1200;
const encoder = new TextEncoder();

/** A payload; `report` names the ids of a report object built from them, absent otherwise. */
interface Payload {
  readonly bytes: Uint8Array;
  readonly report?: { readonly transport_probe_id: string; readonly lambda_request_id: string };
}

const payloads: fc.Arbitrary<Payload> = fc.oneof(
  {
    arbitrary: fc
      .record({
        transport_probe_id: fc.constantFrom(PROBE_ID, 'other-probe'),
        lambda_request_id: fc.constantFrom(...REQUEST_IDS),
        extra: fc.dictionary(
          fc.string({ maxLength: 8 }).filter((key) => !REPORT_KEYS.has(key)),
          fc.jsonValue({ maxDepth: 1 }),
          { maxKeys: 3 },
        ),
      })
      .map(({ extra, ...ids }) => ({
        bytes: encoder.encode(JSON.stringify({ ...(extra as JsonObject), ...ids })),
        report: ids,
      })),
    weight: 4,
  },
  fc.uint8Array({ maxLength: 64 }).map((bytes) => ({ bytes })),
  fc
    .jsonValue({ maxDepth: 3 })
    .filter((value) => typeof value !== 'object' || value === null || Array.isArray(value))
    .map((value) => ({ bytes: encoder.encode(JSON.stringify(value)) })),
  fc
    .integer({ min: 1, max: 5000 })
    .map((depth) => ({ bytes: encoder.encode(`${'['.repeat(depth)}${']'.repeat(depth)}`) })),
);

/** An Invoke output and the response the reference model reads from it. */
interface Output {
  readonly value: unknown;
  readonly expected: LambdaInvokeResponse;
  /** The payload member the mapping can read, which it must copy rather than pass on. */
  readonly readable_payload: unknown;
  readonly report?: Payload['report'];
}

const statuses: fc.Arbitrary<unknown> = fc.oneof(
  { arbitrary: fc.constant(200), weight: 4 },
  fc.integer({ min: -1000, max: 1000 }),
  fc.double(),
  anyValue,
);
const texts: fc.Arbitrary<unknown> = fc.oneof(fc.string({ maxLength: 300 }), anyValue);
const versions: fc.Arbitrary<unknown> = fc.oneof({ arbitrary: fc.constant(VERSION), weight: 4 }, texts);
const functionErrors: fc.Arbitrary<unknown> = fc.oneof(
  { arbitrary: fc.constant(undefined), weight: 4 },
  fc.constant('Unhandled'),
  texts,
);
const requestIds: fc.Arbitrary<unknown> = fc.oneof({ arbitrary: fc.constantFrom(...REQUEST_IDS), weight: 4 }, texts);

const ownString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

// The model's own byte check, total over a value whose prototype cannot be read.
function isBytes(value: unknown): value is Uint8Array {
  try {
    return value instanceof Uint8Array;
  } catch {
    return false;
  }
}

const outputs: fc.Arbitrary<Output> = fc
  .record({
    status: statuses,
    version: versions,
    functionError: functionErrors,
    payload: fc.oneof(
      { arbitrary: payloads, weight: 4 },
      anyValue.map((value) => ({ value })),
    ),
    requestId: requestIds,
    shape: fc.oneof(
      { arbitrary: fc.constant('own'), weight: 6 },
      fc.constantFrom('inherited', 'inherited_metadata', 'throwing_status', 'throwing_payload', 'proxy'),
    ),
  })
  .map(({ status, version, functionError, payload, requestId, shape }) => {
    const payloadValue = 'bytes' in payload ? payload.bytes : payload.value;
    const metadata = shape === 'inherited_metadata' ? inheriting({ requestId }) : { requestId };
    const members: Record<string, unknown> = {
      StatusCode: status,
      ExecutedVersion: version,
      FunctionError: functionError,
      Payload: payloadValue,
      $metadata: metadata,
    };
    const readable = (member: string): unknown => {
      const hidden =
        shape === 'inherited' || shape === 'proxy' || (shape === 'throwing_status' && member === 'StatusCode');
      return hidden || (shape === 'throwing_payload' && member === 'Payload') ? undefined : members[member];
    };
    const executed = ownString(readable('ExecutedVersion'));
    const failed = ownString(readable('FunctionError'));
    const id =
      shape === 'own' || shape === 'throwing_status' || shape === 'throwing_payload' ? ownString(requestId) : undefined;
    const readStatus = readable('StatusCode');
    const readPayload = readable('Payload');
    const expected: LambdaInvokeResponse = {
      kind: 'response',
      status_code: typeof readStatus === 'number' ? readStatus : 0,
      ...(executed === undefined ? {} : { executed_version: executed }),
      ...(failed === undefined ? {} : { function_error: failed }),
      payload: isBytes(readPayload) ? Uint8Array.from(readPayload) : new Uint8Array(),
      ...(id === undefined ? {} : { request_id: id }),
    };
    const value =
      shape === 'inherited'
        ? inheriting(members)
        : shape === 'throwing_status'
          ? withThrowingMember({ ...members, StatusCode: undefined }, 'StatusCode')
          : shape === 'throwing_payload'
            ? withThrowingMember({ ...members, Payload: undefined }, 'Payload')
            : shape === 'proxy'
              ? throwingProxy(members)
              : members;
    const report = 'bytes' in payload && readPayload === payloadValue ? payload.report : undefined;
    return { value, expected, readable_payload: readPayload, ...(report === undefined ? {} : { report }) };
  });

// The reference model of the judge over a mapped response (module header rule).
function expectedJudgement(
  response: LambdaInvokeResponse,
  report: Payload['report'],
): {
  readonly recorded: boolean;
  readonly codes: readonly string[];
} {
  const status = response.status_code;
  const recordable =
    Number.isInteger(status) && status >= 100 && status <= 599 && ownString(response.request_id) !== undefined;
  if (!recordable) {
    return { recorded: false, codes: ['PROBE_WORKLOAD_INVOKE_AMBIGUOUS'] };
  }
  const codes: string[] = response.executed_version === VERSION ? [] : ['PROBE_WORKLOAD_VERSION_MISMATCH'];
  if (status !== 200 || response.function_error !== undefined) {
    return { recorded: true, codes: [...codes, 'PROBE_WORKLOAD_FAILED'] };
  }
  const matches = report?.transport_probe_id === PROBE_ID && report.lambda_request_id === response.request_id;
  return { recorded: true, codes: matches ? codes : [...codes, 'PROBE_WORKLOAD_REPORT_UNEXPECTED'] };
}

function boundedFailures(judged: ProbeInvocationJudgement): boolean {
  const reasons = judged.kind === 'started' ? judged.failures : [judged.reason];
  return reasons.every((reason) => reason.subject === 'BR-RUA-027' && reason.detail.length <= DETAIL_BOUND);
}

const thrownValues: fc.Arbitrary<unknown> = fc.oneof(
  anyValue,
  fc
    .record({ fault: fc.constantFrom('client', 'server'), status: fc.integer({ min: 300, max: 600 }), name: texts })
    .map(({ fault, status, name }) =>
      Object.defineProperties(new Error('thrown'), {
        name: { value: name },
        $fault: { value: fault, enumerable: true },
        $metadata: { value: { httpStatusCode: status }, enumerable: true },
      }),
    ),
);

describe('lambdaInvokeResponseOf properties', () => {
  it('reads exactly the own, well-typed members the reference model reads, and copies the payload', () => {
    fc.assert(
      fc.property(outputs, ({ value, expected, readable_payload: readable }) => {
        const mapped = lambdaInvokeResponseOf(value);
        assert.deepEqual(mapped, expected);
        assert.notEqual(mapped.payload, readable);
      }),
      fuzzParameters(),
    );
  });
});

describe('judgeProbeInvocation properties', () => {
  it('judges every mapped response as the reference model does, with bounded diagnostics', () => {
    fc.assert(
      fc.property(outputs, ({ value, report }) => {
        const response = lambdaInvokeResponseOf(value);
        const judged = judgeProbeInvocation(response, PLAN);
        const model = expectedJudgement(response, report);
        assert.equal(judged.kind, 'started');
        assert.equal(judged.invocation_returned, true);
        assert.deepEqual(
          judged.failures.map((reason) => reason.code),
          model.codes,
        );
        assert.equal(judged.invoked !== undefined, model.recorded);
        if (judged.invoked !== undefined) {
          assert.deepEqual(judged.invoked, {
            lambda_request_id: response.request_id,
            status_code: response.status_code,
            ...(response.executed_version === undefined ? {} : { executed_version: response.executed_version }),
            ...(response.function_error === undefined ? {} : { function_error: response.function_error }),
          });
        }
        assert.ok(boundedFailures(judged));
      }),
      fuzzParameters(),
    );
  });

  it('starts no probe exactly for a definitive rejection of the Invoke, and an unreturned one otherwise', () => {
    fc.assert(
      fc.property(thrownValues, (thrown) => {
        const failure: ProbeWorkloadInvokeResult = probeInvokeFailureOf(thrown);
        const judged = judgeProbeInvocation(failure, PLAN);
        if (failure.kind === 'rejected') {
          assert.equal(judged.kind === 'not_started' ? judged.reason.code : judged.kind, 'PROBE_WORKLOAD_NOT_INVOKED');
        } else {
          assert.deepEqual(
            judged.kind === 'started'
              ? [judged.invoked, judged.invocation_returned, judged.failures.map((r) => r.code)]
              : [],
            [undefined, false, ['PROBE_WORKLOAD_INVOKE_AMBIGUOUS']],
          );
        }
        assert.ok(boundedFailures(judged));
      }),
      fuzzParameters(),
    );
  });
});
