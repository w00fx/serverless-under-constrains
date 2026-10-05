// Conformance of InProcessProviderInvoker with the Lambda binding it replaces in the rehearsal
// (`createProviderInvoker`, design §9.4, §9.9): a 200 from the invoked version whose payload the
// real response parser accepts; a thrown handler error as `FunctionError: Unhandled`; an abort
// that settles at once as the binding's AbortError while the function keeps running.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseProviderResponse } from '../../../../src/provider-client/provider-response.ts';
import type { ProviderRefundCall } from '../../../../src/record-contract/records/group-a/provider_refund_call.ts';
import { ABORTED_SETTLEMENT } from '../../../support/provider-client/scripted-provider-invoker.ts';
import {
  IN_PROCESS_ABORTED,
  InProcessProviderInvoker,
} from '../../../support/transport-rehearsal/in-process-provider-invoker.ts';
import {
  ATTEMPT_ID,
  OTHER_TRIAL_ID,
  PROVIDER_REQUEST_ID,
  providerHarness,
  seedRunTrial,
  validCall,
} from '../../../unit/refund-provider/support/provider-fixtures.ts';

const QUALIFIER = '5';
const EXPECTED = { qualifier: QUALIFIER, attempt_id: ATTEMPT_ID, provider_request_id: PROVIDER_REQUEST_ID };

function call(overrides: Readonly<Record<string, string>> = {}): ProviderRefundCall {
  return validCall(overrides) as unknown as ProviderRefundCall;
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

  it('reports a non-Error throw by name, as the Lambda runtime does', async () => {
    const invoker = new InProcessProviderInvoker(
      { handle: (): Promise<never> => Promise.reject(new Error('x')) },
      QUALIFIER,
    );
    const thrownString = new InProcessProviderInvoker(
      // A defective function that rejects with a string, not an Error.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      { handle: (): Promise<never> => Promise.reject('plain') },
      QUALIFIER,
    );
    const first = await invoker.invoke(call(), new AbortController().signal);
    const second = await thrownString.invoke(call(), new AbortController().signal);
    assert.equal(first.kind === 'response' ? first.function_error : '', 'Unhandled');
    const body = JSON.parse(
      new TextDecoder().decode(second.kind === 'response' ? second.payload : new Uint8Array()),
    ) as unknown;
    assert.deepEqual(body, { errorType: 'NonErrorThrown', errorMessage: 'plain' });
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
