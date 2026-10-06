// The probe caller's single Invoke, mapped and judged (BR-RUA-027, AC-RUA-053, D-29): a rejected
// Invoke starts no probe; a recordable response is journaled with its status, executed version and
// function error, and anything unexpected in it is a diagnostic; a response the journal cannot
// hold, or none at all, starts the probe without a recorded invocation. Total over hostile SDK
// output (A-05).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProbeWorkloadRequest } from '../../../src/record-contract/records/group-a/probe_workload_request.ts';
import {
  judgeProbeInvocation,
  lambdaInvokeResponseOf,
  probeInvokeFailureOf,
} from '../../../src/trial-execution/probe-invocation.ts';
import type { LambdaInvokeResponse } from '../../../src/trial-execution/probe-invocation.ts';
import { MANIFEST_SHA } from './support/trial-execution-fixtures.ts';

const PROBE_ID = '2559d5f6-ec95-4777-a74e-452fcfde7526';
const REQUEST = {
  schema_version: 1,
  record_type: 'probe_workload_request',
  transport_probe_id: PROBE_ID,
  execution_manifest_sha256: MANIFEST_SHA,
  payment_id: 'pay-poc-001',
  refund_request_id: 'ref-poc-001',
  amount_minor: 10000,
  currency: 'BRL',
} as ProbeWorkloadRequest;
const PLAN = { request: REQUEST, probe_caller_version: '1' };

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function response(overrides: Partial<LambdaInvokeResponse> = {}): LambdaInvokeResponse {
  return {
    kind: 'response',
    status_code: 200,
    executed_version: '1',
    payload: bytes({ transport_probe_id: PROBE_ID, lambda_request_id: 'req-1' }),
    request_id: 'req-1',
    ...overrides,
  };
}

function withoutRequestId(): LambdaInvokeResponse {
  const { request_id: _requestId, ...rest } = response();
  return rest;
}

function codes(judged: ReturnType<typeof judgeProbeInvocation>): readonly string[] {
  return judged.kind === 'started' ? judged.failures.map((failure) => failure.code) : [judged.reason.code];
}

describe('lambdaInvokeResponseOf', () => {
  it('reads every member of a returned Invoke, copying the payload', () => {
    const payload = Uint8Array.of(1, 2);
    const mapped = lambdaInvokeResponseOf({
      StatusCode: 200,
      ExecutedVersion: '4',
      FunctionError: 'Unhandled',
      Payload: payload,
      $metadata: { requestId: 'req-7' },
    });
    assert.deepEqual(mapped, {
      kind: 'response',
      status_code: 200,
      executed_version: '4',
      function_error: 'Unhandled',
      payload,
      request_id: 'req-7',
    });
    assert.notEqual(mapped.payload, payload);
  });

  it('reads absent, empty, mistyped and inherited members as absent', () => {
    const absent = { kind: 'response', status_code: 0, payload: new Uint8Array() };
    assert.deepEqual(lambdaInvokeResponseOf({}), absent);
    assert.deepEqual(lambdaInvokeResponseOf(undefined), absent);
    assert.deepEqual(
      lambdaInvokeResponseOf({
        StatusCode: '200',
        ExecutedVersion: '',
        FunctionError: 3,
        Payload: [1],
        $metadata: 'm',
      }),
      absent,
    );
    assert.deepEqual(
      lambdaInvokeResponseOf(Object.create({ StatusCode: 200, $metadata: { requestId: 'r' } }) as object),
      absent,
    );
  });

  it('never throws on a throwing getter', () => {
    const hostile = { StatusCode: 202 };
    Object.defineProperty(hostile, 'Payload', {
      enumerable: true,
      get: (): never => {
        throw new Error('boom');
      },
    });
    assert.deepEqual(lambdaInvokeResponseOf(hostile), {
      kind: 'response',
      status_code: 202,
      payload: new Uint8Array(),
    });
  });

  // Regression (A-05 fuzz target probe-invocation.fuzz.test.ts): an own Payload that is a proxy
  // whose getPrototypeOf trap throws made the `instanceof Uint8Array` check throw.
  it('never throws on a payload whose prototype cannot be read', () => {
    const payload = new Proxy(
      {},
      {
        getPrototypeOf: (): never => {
          throw new Error('hostile proxy trap');
        },
      },
    );
    assert.deepEqual(lambdaInvokeResponseOf({ StatusCode: 200, Payload: payload }), {
      kind: 'response',
      status_code: 200,
      payload: new Uint8Array(),
    });
  });
});

describe('probeInvokeFailureOf', () => {
  it('rejects a definitive client fault and reads anything else as ambiguous', () => {
    const throttled = Object.assign(new Error('slow down'), {
      name: 'TooManyRequestsException',
      $fault: 'client',
      $metadata: { httpStatusCode: 429 },
    });
    const rejected = probeInvokeFailureOf(throttled);
    assert.equal(rejected.kind, 'rejected');
    assert.equal(rejected.code, 'TooManyRequestsException');
    const ambiguous = probeInvokeFailureOf(new Error('socket hang up'));
    assert.deepEqual(ambiguous, {
      kind: 'ambiguous',
      code: 'Error',
      detail: 'Error with no definitive client-fault response: socket hang up',
    });
  });
});

describe('judgeProbeInvocation', () => {
  it('starts no probe when Lambda rejected the Invoke', () => {
    const judged = judgeProbeInvocation({ kind: 'rejected', code: 'ResourceNotFoundException', detail: 'gone' }, PLAN);
    assert.equal(judged.kind, 'not_started');
    assert.deepEqual(codes(judged), ['PROBE_WORKLOAD_NOT_INVOKED']);
    assert.match(judged.reason.detail, /Lambda rejected the Invoke: gone/);
  });

  it('starts the probe unrecorded and unreturned when the Invoke settled without a response', () => {
    const judged = judgeProbeInvocation({ kind: 'ambiguous', code: 'Error', detail: 'socket hang up' }, PLAN);
    assert.deepEqual(judged.kind === 'started' ? [judged.invoked, judged.invocation_returned] : [], [undefined, false]);
    assert.deepEqual(codes(judged), ['PROBE_WORKLOAD_INVOKE_AMBIGUOUS']);
  });

  it('starts the probe unrecorded but returned when the response has no request id or no HTTP status', () => {
    for (const unrecordable of [
      withoutRequestId(),
      // The journal refuses an empty lambda_request_id, so an empty id is no id.
      response({ request_id: '' }),
      response({ status_code: 99 }),
      response({ status_code: 600 }),
      response({ status_code: 200.5 }),
      response({ status_code: 0 }),
    ]) {
      const judged = judgeProbeInvocation(unrecordable, PLAN);
      assert.equal(judged.kind, 'started');
      assert.equal(judged.invoked, undefined);
      assert.equal(judged.invocation_returned, true);
      assert.deepEqual(codes(judged), ['PROBE_WORKLOAD_INVOKE_AMBIGUOUS']);
    }
    const noId = judgeProbeInvocation(withoutRequestId(), PLAN);
    assert.match(noId.kind === 'started' ? (noId.failures[0]?.detail ?? '') : '', /status 200 with no request id/);
    const badStatus = judgeProbeInvocation(response({ status_code: 600 }), PLAN);
    assert.match(
      badStatus.kind === 'started' ? (badStatus.failures[0]?.detail ?? '') : '',
      /status 600 with a request id/,
    );
  });

  it('records the probe caller’s report response with no diagnostic', () => {
    assert.deepEqual(judgeProbeInvocation(response(), PLAN), {
      kind: 'started',
      invoked: { lambda_request_id: 'req-1', status_code: 200, executed_version: '1' },
      invocation_returned: true,
      failures: [],
    });
    for (const status of [100, 599]) {
      const judged = judgeProbeInvocation(response({ status_code: status }), PLAN);
      assert.equal(judged.kind === 'started' ? judged.invoked?.status_code : 0, status);
    }
  });

  it('records another or no executed version with a diagnostic (AC-RUA-053)', () => {
    const other = judgeProbeInvocation(response({ executed_version: '2' }), PLAN);
    assert.deepEqual(codes(other), ['PROBE_WORKLOAD_VERSION_MISMATCH']);
    assert.equal(other.kind === 'started' ? other.invoked?.executed_version : '', '2');
    assert.match(other.kind === 'started' ? (other.failures[0]?.detail ?? '') : '', /executed version 2, not 1/);
    const { executed_version: _version, ...unversioned } = response();
    const none = judgeProbeInvocation(unversioned, PLAN);
    assert.deepEqual(codes(none), ['PROBE_WORKLOAD_VERSION_MISMATCH']);
    assert.match(none.kind === 'started' ? (none.failures[0]?.detail ?? '') : '', /executed no version, not 1/);
    assert.equal(none.kind === 'started' && none.invoked !== undefined && 'executed_version' in none.invoked, false);
  });

  it('records a function error or a non-200 status with a diagnostic and reads no report', () => {
    const failed = judgeProbeInvocation(response({ function_error: 'Unhandled', payload: bytes('x') }), PLAN);
    assert.deepEqual(codes(failed), ['PROBE_WORKLOAD_FAILED']);
    assert.equal(failed.kind === 'started' ? failed.invoked?.function_error : '', 'Unhandled');
    assert.match(
      failed.kind === 'started' ? (failed.failures[0]?.detail ?? '') : '',
      /status 200 with function error Unhandled/,
    );
    const throttled = judgeProbeInvocation(response({ status_code: 502, executed_version: '9' }), PLAN);
    assert.deepEqual(codes(throttled), ['PROBE_WORKLOAD_VERSION_MISMATCH', 'PROBE_WORKLOAD_FAILED']);
    assert.match(
      throttled.kind === 'started' ? (throttled.failures[1]?.detail ?? '') : '',
      /status 502 with function error none/,
    );
  });

  it('reports a payload that is not this probe’s report of this request', () => {
    const payloads: readonly (readonly [Uint8Array, RegExp])[] = [
      [Uint8Array.of(0xff), /not one JSON document/],
      [bytes([1]), /is array \[1\], not the probe caller's report object/],
      [bytes({ transport_probe_id: 'other', lambda_request_id: 'req-1' }), /names transport_probe_id string "other"/],
      [bytes({ transport_probe_id: PROBE_ID, lambda_request_id: 'req-2' }), /lambda_request_id string "req-2"/],
      [bytes({}), /names transport_probe_id absent and lambda_request_id absent/],
    ];
    for (const [payload, detail] of payloads) {
      const judged = judgeProbeInvocation(response({ payload }), PLAN);
      assert.deepEqual(codes(judged), ['PROBE_WORKLOAD_REPORT_UNEXPECTED']);
      assert.match(judged.kind === 'started' ? (judged.failures[0]?.detail ?? '') : '', detail);
    }
  });
});
