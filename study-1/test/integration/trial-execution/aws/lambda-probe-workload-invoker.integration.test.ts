// The Lambda binding of the probe workload invoker (BR-RUA-027, AC-RUA-053; design §9.4 probe-caller
// row): a real LambdaClient built by `createProviderLambdaClient` serializes, signs and
// deserializes through a scripted HTTP layer. The test sees the exact Invoke on the wire (the
// probe caller's published version, RequestResponse, the canonical probe_workload_request), no
// client timeout (every handler timeout disabled, so only the probe caller's 10 s function timeout
// ends it), the executed version and request id of every response, and exactly one request for
// every answer: the Invoke is never retried.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createProviderLambdaClient } from '../../../../src/provider-client/aws/provider-lambda-client.ts';
import { PROVIDER_HTTP_HANDLER_OPTIONS } from '../../../../src/provider-client/transport-options.ts';
import { canonicalJson } from '../../../../src/record-contract/canonical-json.ts';
import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import type { ProbeWorkloadRequest } from '../../../../src/record-contract/records/group-a/probe_workload_request.ts';
import { createLambdaProbeWorkloadInvoker } from '../../../../src/trial-execution/aws/lambda-probe-workload-invoker.ts';
import type { ProbeWorkloadInvoker } from '../../../../src/trial-execution/trial-execution-ports.ts';
import { ScriptedLambdaInvokeHandler } from '../support/scripted-lambda-invoke-handler.ts';

const FUNCTION_NAME = 'suc1-p-probe-caller';
const CREDENTIALS = { accessKeyId: 'AKIDPROBEINVOKER', secretAccessKey: 'not-a-secret' };
const REQUEST = {
  schema_version: 1,
  record_type: 'probe_workload_request',
  transport_probe_id: '2559d5f6-ec95-4777-a74e-452fcfde7526',
  execution_manifest_sha256: 'b'.repeat(64),
  payment_id: 'pay-poc-001',
  refund_request_id: 'ref-poc-001',
  amount_minor: 10000,
  currency: 'BRL',
} as ProbeWorkloadRequest;
const REPORT = new TextEncoder().encode('{"transport_probe_id":"2559d5f6-ec95-4777-a74e-452fcfde7526"}');

function setup(): { readonly workload: ProbeWorkloadInvoker; readonly http: ScriptedLambdaInvokeHandler } {
  const http = new ScriptedLambdaInvokeHandler();
  const client = createProviderLambdaClient(http.factory, { credentials: CREDENTIALS });
  return { workload: createLambdaProbeWorkloadInvoker(client, { function_name: FUNCTION_NAME, version: '1' }), http };
}

describe('createLambdaProbeWorkloadInvoker', () => {
  it('sends one RequestResponse Invoke of the published version with the canonical request', async () => {
    const { workload, http } = setup();
    http.script({ kind: 'invoke_response', status: 200, request_id: 'req-1', executed_version: '1', payload: REPORT });
    await workload.invokeWorkload(REQUEST);
    const [request, ...others] = http.requests();
    assert.deepEqual(others, []);
    assert.ok(request !== undefined);
    assert.equal(request.method, 'POST');
    assert.equal(request.path, `/2015-03-31/functions/${FUNCTION_NAME}/invocations`);
    assert.deepEqual(request.query, { Qualifier: '1' });
    assert.equal(request.headers['x-amz-invocation-type'], 'RequestResponse');
    assert.equal(new TextDecoder().decode(request.body), canonicalJson(REQUEST as unknown as JsonValue));
  });

  it('runs with one attempt and no client timeout', async () => {
    const { workload: _workload, http } = setup();
    assert.deepEqual(http.receivedOptions(), [PROVIDER_HTTP_HANDLER_OPTIONS]);
    assert.equal(PROVIDER_HTTP_HANDLER_OPTIONS.requestTimeout, 0);
    const client = createProviderLambdaClient(new ScriptedLambdaInvokeHandler().factory, { credentials: CREDENTIALS });
    assert.equal(await client.config.maxAttempts(), 1);
  });

  it('returns the status, executed version, function error, payload and request id', async () => {
    const { workload, http } = setup();
    http.script({ kind: 'invoke_response', status: 200, request_id: 'req-1', executed_version: '1', payload: REPORT });
    http.script({
      kind: 'invoke_response',
      status: 200,
      request_id: 'req-2',
      executed_version: '1',
      function_error: 'Unhandled',
      payload: REPORT,
    });
    assert.deepEqual(await workload.invokeWorkload(REQUEST), {
      kind: 'response',
      status_code: 200,
      executed_version: '1',
      payload: REPORT,
      request_id: 'req-1',
    });
    assert.deepEqual(await workload.invokeWorkload(REQUEST), {
      kind: 'response',
      status_code: 200,
      executed_version: '1',
      function_error: 'Unhandled',
      payload: REPORT,
      request_id: 'req-2',
    });
    assert.equal(http.requests().length, 2);
  });

  it('rejects a definitive 4xx client fault: the probe caller never ran', async () => {
    for (const [type, status] of [
      ['ResourceNotFoundException', 404],
      ['TooManyRequestsException', 429],
    ] as const) {
      const { workload, http } = setup();
      http.script({ kind: 'service_error', status, type, request_id: 'req-x' });
      const settled = await workload.invokeWorkload(REQUEST);
      assert.equal(settled.kind, 'rejected', type);
      assert.equal(settled.code, type);
      assert.equal(http.requests().length, 1, type);
    }
  });

  it('reads a 5xx and a network error as ambiguous, after exactly one request each', async () => {
    const server = setup();
    server.http.script({ kind: 'service_error', status: 502, type: 'EC2UnexpectedException' });
    assert.equal((await server.workload.invokeWorkload(REQUEST)).kind, 'ambiguous');
    assert.equal(server.http.requests().length, 1);
    const network = setup();
    network.http.script({ kind: 'network_error', error: new Error('socket hang up') });
    assert.equal((await network.workload.invokeWorkload(REQUEST)).kind, 'ambiguous');
    assert.equal(network.http.requests().length, 1);
  });
});
