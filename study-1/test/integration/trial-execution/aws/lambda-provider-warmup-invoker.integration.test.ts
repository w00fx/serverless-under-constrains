// The Lambda binding of the provider warm-up (addendum §2.1, BR-RUA-053; design §9.4): a real
// LambdaClient built by `createProviderLambdaClient` serializes, signs and deserializes through a
// scripted HTTP layer, so the test sees the exact Invoke on the wire (the published version,
// RequestResponse, the canonical warm-up request) and the settlement of every answer. One warm-up
// is one request: a throttle or a 5xx is never retried.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createProviderLambdaClient } from '../../../../src/provider-client/aws/provider-lambda-client.ts';
import { PROVIDER_HTTP_HANDLER_OPTIONS } from '../../../../src/provider-client/transport-options.ts';
import { canonicalJson } from '../../../../src/record-contract/canonical-json.ts';
import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import type { ProviderWarmupRequest } from '../../../../src/record-contract/records/group-b/provider_warmup_request.ts';
import { createLambdaProviderWarmupInvoker } from '../../../../src/trial-execution/aws/lambda-provider-warmup-invoker.ts';
import type { ProviderWarmupInvoker } from '../../../../src/trial-execution/trial-execution-ports.ts';
import { ScriptedLambdaInvokeHandler } from '../support/scripted-lambda-invoke-handler.ts';

const FUNCTION_NAME = 'suc1-p-refund-provider';
const CREDENTIALS = { accessKeyId: 'AKIDWARMUPINVOKER', secretAccessKey: 'not-a-secret' };
const REQUEST: ProviderWarmupRequest = {
  schema_version: 1,
  record_type: 'provider_warmup_request',
  run_id: '1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d',
  execution_manifest_sha256: 'a'.repeat(64),
  warmup_id: '2c3d4e5f-6071-4b8c-9d0e-1f2a3b4c5d6e',
  trial_id: '3d4e5f60-7182-4c9d-8e1f-2a3b4c5d6e7f',
} as ProviderWarmupRequest;
const COMPLETION = new TextEncoder().encode('{"record_type":"provider_warmup_completed"}');

function setup(): { readonly warmup: ProviderWarmupInvoker; readonly http: ScriptedLambdaInvokeHandler } {
  const http = new ScriptedLambdaInvokeHandler();
  const client = createProviderLambdaClient(http.factory, { credentials: CREDENTIALS });
  return { warmup: createLambdaProviderWarmupInvoker(client, { function_name: FUNCTION_NAME, qualifier: '3' }), http };
}

describe('createLambdaProviderWarmupInvoker', () => {
  it('sends one RequestResponse Invoke of the published version with the canonical request', async () => {
    const { warmup, http } = setup();
    http.script({ kind: 'invoke_response', status: 200, executed_version: '3', payload: COMPLETION });
    await warmup.invokeWarmup(REQUEST);
    const [request, ...others] = http.requests();
    assert.deepEqual(others, []);
    assert.ok(request !== undefined);
    assert.equal(request.method, 'POST');
    assert.equal(request.path, `/2015-03-31/functions/${FUNCTION_NAME}/invocations`);
    assert.deepEqual(request.query, { Qualifier: '3' });
    assert.equal(request.headers['x-amz-invocation-type'], 'RequestResponse');
    assert.equal(new TextDecoder().decode(request.body), canonicalJson(REQUEST as unknown as JsonValue));
    assert.deepEqual(http.receivedOptions(), [PROVIDER_HTTP_HANDLER_OPTIONS]);
  });

  it('settles a response with its status, executed version, function error and payload', async () => {
    const { warmup, http } = setup();
    http.script({ kind: 'invoke_response', status: 200, executed_version: '3', payload: COMPLETION });
    http.script({
      kind: 'invoke_response',
      status: 200,
      executed_version: '2',
      function_error: 'Unhandled',
      payload: COMPLETION,
    });
    assert.deepEqual(await warmup.invokeWarmup(REQUEST), {
      kind: 'response',
      status_code: 200,
      executed_version: '3',
      function_error: undefined,
      payload: COMPLETION,
    });
    assert.deepEqual(await warmup.invokeWarmup(REQUEST), {
      kind: 'response',
      status_code: 200,
      executed_version: '2',
      function_error: 'Unhandled',
      payload: COMPLETION,
    });
  });

  it('settles a throttle and a 5xx as transport errors with their status, after one request each', async () => {
    for (const [type, status] of [
      ['TooManyRequestsException', 429],
      ['ServiceException', 500],
    ] as const) {
      const { warmup, http } = setup();
      http.script({ kind: 'service_error', status, type });
      const settled = await warmup.invokeWarmup(REQUEST);
      assert.equal(settled.kind, 'transport_error', type);
      assert.equal(settled.http_status, status, type);
      assert.equal(settled.error_name, type, type);
      assert.equal(http.requests().length, 1, type);
    }
  });

  it('settles a network error as a transport error without a status', async () => {
    const { warmup, http } = setup();
    http.script({ kind: 'network_error', error: Object.assign(new Error('socket hang up'), { name: 'NetworkError' }) });
    assert.deepEqual(await warmup.invokeWarmup(REQUEST), {
      kind: 'transport_error',
      error_name: 'NetworkError',
      message: 'socket hang up',
    });
  });
});
