// Conformance of InProcessProviderInvoker with the Lambda binding it replaces in the rehearsal
// (`createProviderInvoker`, design §9.4, §9.9): a 200 from the invoked version whose payload the
// real response parser accepts; a thrown handler error as `FunctionError: Unhandled` with the
// error payload of the Node.js runtime interface client (`toRapidResponse`); an abort that
// settles at once as the binding's AbortError while the function keeps running; and a request
// that is not a refund call (the warm-up) through the same emulated Invoke.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProviderTransportResult } from '../../../../src/provider-client/provider-invocation-port.ts';
import { parseProviderResponse } from '../../../../src/provider-client/provider-response.ts';
import type { ProviderRefundCall } from '../../../../src/record-contract/records/group-a/provider_refund_call.ts';
import { ABORTED_SETTLEMENT } from '../../../support/provider-client/scripted-provider-invoker.ts';
import {
  IN_PROCESS_ABORTED,
  InProcessProviderInvoker,
} from '../../../support/transport-rehearsal/in-process-provider-invoker.ts';
import { RejectingProviderFunction } from '../../../support/transport-rehearsal/rejecting-provider-function.ts';
import {
  ATTEMPT_ID,
  MANIFEST_SHA,
  OTHER_TRIAL_ID,
  PROVIDER_REQUEST_ID,
  RUN_ID,
  providerHarness,
  seedRunTrial,
  validCall,
} from '../../../support/refund-provider/provider-fixtures.ts';

const QUALIFIER = '5';
const EXPECTED = { qualifier: QUALIFIER, attempt_id: ATTEMPT_ID, provider_request_id: PROVIDER_REQUEST_ID };

function call(overrides: Readonly<Record<string, string>> = {}): ProviderRefundCall {
  return validCall(overrides) as unknown as ProviderRefundCall;
}

function errorBody(result: ProviderTransportResult): Readonly<Record<string, unknown>> {
  assert.equal(result.kind, 'response');
  return JSON.parse(new TextDecoder().decode(result.payload)) as Readonly<Record<string, unknown>>;
}

describe('InProcessProviderInvoker conformance', () => {
  it('answers like a RequestResponse Invoke of the qualified version', async () => {
    const harness = providerHarness();
    seedRunTrial(harness, 'CONTROL');
    const invoker = new InProcessProviderInvoker(harness.provider, QUALIFIER);
    const result = await invoker.invoke(call(), new AbortController().signal);
    assert.equal(result.kind, 'response');
    assert.equal(result.status_code, 200);
    assert.equal(result.executed_version, QUALIFIER);
    assert.equal(result.function_error, undefined);
    assert.equal(parseProviderResponse(result, EXPECTED).kind, 'succeeded');
    assert.deepEqual(
      invoker.finished().map((entry) => [entry.aborted_by_client, entry.execution.kind]),
      [[false, 'returned']],
    );
  });

  it('reports an error the handler throws as FunctionError Unhandled with the runtime error payload', async () => {
    const harness = providerHarness();
    const invoker = new InProcessProviderInvoker(harness.provider, QUALIFIER);
    const result = await invoker.invoke(call({ trial_id: OTHER_TRIAL_ID }), new AbortController().signal);
    assert.equal(result.kind === 'response' ? result.function_error : '', 'Unhandled');
    const body = JSON.parse(
      new TextDecoder().decode(result.kind === 'response' ? result.payload : new Uint8Array()),
    ) as Readonly<Record<string, unknown>>;
    assert.equal(body['errorType'], 'ProviderFault');
    assert.match(String(body['errorMessage']), /^[A-Z_]+: /);
    assert.equal(parseProviderResponse(result, EXPECTED).kind, 'failed');
    assert.deepEqual(
      invoker.finished().map((entry) => entry.execution),
      [{ kind: 'threw', error_type: 'ProviderFault' }],
    );
  });

  it('reports an Error as the runtime does: its name, its message and its stack lines as trace', async () => {
    const provider = new RejectingProviderFunction(new RangeError('out\x7Fof range'));
    const invoker = new InProcessProviderInvoker(provider, QUALIFIER);
    const result = await invoker.invoke(call(), new AbortController().signal);
    assert.equal(result.kind === 'response' ? result.function_error : '', 'Unhandled');
    const body = errorBody(result);
    assert.equal(body['errorType'], 'RangeError');
    assert.equal(body['errorMessage'], 'out%7Fof range');
    const trace = body['trace'] as readonly string[];
    assert.equal(trace[0], 'RangeError: out%7Fof range');
    assert.ok(trace.length > 1, JSON.stringify(trace));
    assert.equal(provider.payloads().length, 1);
    assert.deepEqual(
      invoker.finished().map((entry) => entry.execution),
      [{ kind: 'threw', error_type: 'RangeError' }],
    );
  });

  it('reports a non-Error rejection by its typeof with an empty trace, as the runtime does', async () => {
    const thrownString = new InProcessProviderInvoker(new RejectingProviderFunction('plain'), QUALIFIER);
    const thrownNumber = new InProcessProviderInvoker(new RejectingProviderFunction(42), QUALIFIER);
    assert.deepEqual(errorBody(await thrownString.invoke(call(), new AbortController().signal)), {
      errorType: 'string',
      errorMessage: 'plain',
      trace: [],
    });
    assert.deepEqual(errorBody(await thrownNumber.invoke(call(), new AbortController().signal)), {
      errorType: 'number',
      errorMessage: '42',
      trace: [],
    });
  });

  it('reports a rejection whose members cannot be read as the runtime fallback "handled"', async () => {
    const noStack = new Error('no stack');
    Reflect.deleteProperty(noStack, 'stack');
    for (const rejection of [null, undefined, noStack]) {
      const invoker = new InProcessProviderInvoker(new RejectingProviderFunction(rejection), QUALIFIER);
      const result = await invoker.invoke(call(), new AbortController().signal);
      assert.equal(result.kind === 'response' ? result.function_error : '', 'Unhandled');
      assert.deepEqual(errorBody(result), {
        errorType: 'handled',
        errorMessage:
          'callback called with Error argument, but there was a problem while retrieving one or more of its message, name, and stack',
      });
    }
  });

  it('carries a request that is not a refund call (the warm-up) through the same emulated Invoke', async () => {
    const harness = providerHarness();
    const invoker = new InProcessProviderInvoker(harness.provider, QUALIFIER);
    const warmup = {
      schema_version: 1,
      record_type: 'provider_warmup_request',
      run_id: RUN_ID,
      execution_manifest_sha256: MANIFEST_SHA,
      warmup_id: 'aaaaaaaa-0000-4000-8000-0000000000aa',
    };
    const result = await invoker.invokeRequest(warmup);
    assert.equal(result.kind, 'response');
    assert.equal(result.status_code, 200);
    assert.equal(result.executed_version, QUALIFIER);
    assert.equal(result.function_error, undefined);
    assert.equal(errorBody(result)['record_type'], 'provider_warmup_completed');
    assert.deepEqual(invoker.requests(), [warmup]);
    assert.deepEqual(invoker.finished(), []);
  });

  it('settles an aborted call at once as the binding AbortError while the provider keeps running', async () => {
    const harness = providerHarness();
    seedRunTrial(harness, 'COMMIT_THEN_TIMEOUT');
    const invoker = new InProcessProviderInvoker(harness.provider, QUALIFIER);
    const abort = new AbortController();
    const pending = invoker.invoke(call(), abort.signal);
    await harness.time.advanceBy(1_000);
    abort.abort();
    assert.deepEqual(await pending, IN_PROCESS_ABORTED);
    assert.deepEqual(IN_PROCESS_ABORTED, ABORTED_SETTLEMENT);
    assert.deepEqual(invoker.finished(), []);
    await harness.time.advanceBy(20_000);
    await invoker.whenIdle();
    assert.deepEqual(
      invoker.finished().map((entry) => [entry.aborted_by_client, entry.execution.kind]),
      [[true, 'returned']],
    );
  });
});
