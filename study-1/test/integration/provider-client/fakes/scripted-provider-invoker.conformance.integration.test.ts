// Conformance of ScriptedProviderInvoker (design §12.2): its settlements have exactly the shapes
// the real Lambda binding produces through a real LambdaClient, the aborted settlement included,
// and each script settles at its virtual time. `rejectAfter`, `throwBeforeSend`,
// `returnWithoutPromise` and `ignoreAbortForever` have no real counterpart (the real port never
// rejects and settles at once on abort): they emulate a defective port.

import assert from 'node:assert/strict';
import { setImmediate as nextMacrotask } from 'node:timers/promises';
import { describe, it } from 'node:test';

import { createProviderLambdaClient } from '../../../../src/provider-client/aws/provider-lambda-client.ts';
import { createProviderInvoker } from '../../../../src/provider-client/aws/provider-lambda-invoker.ts';
import type { ProviderTransportResult } from '../../../../src/provider-client/provider-invocation-port.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';
import {
  invokeResponse,
  jsonBytes,
  MS,
  PROVIDER_CALL,
  succeededResponder,
} from '../../../support/provider-client/provider-client-fixtures.ts';
import type { ScriptedHttpResponse } from '../../../support/provider-client/recording-http-handler.ts';
import {
  ABORTED_SETTLEMENT,
  ScriptedProviderInvoker,
} from '../../../support/provider-client/scripted-provider-invoker.ts';
import { SpyHttpHandlerFactory } from '../../../support/provider-client/spy-http-handler-factory.ts';

const TEST_CREDENTIALS = { accessKeyId: 'AKIDPROVIDERCLIENT', secretAccessKey: 'not-a-secret' };

// The settlement of the real binding for one scripted HTTP exchange; `abortAfterSend` aborts
// once the request reached the handler.
async function realSettlement(http: ScriptedHttpResponse, abortAfterSend = false): Promise<ProviderTransportResult> {
  const factory = new SpyHttpHandlerFactory();
  const invoker = createProviderInvoker(createProviderLambdaClient(factory.create, { credentials: TEST_CREDENTIALS }), {
    function_name: 'suc-provider',
    qualifier: '7',
  });
  factory.onlyHandler().respondWith(http);
  const controller = new AbortController();
  const pending = invoker.invoke(PROVIDER_CALL, controller.signal);
  while (abortAfterSend && factory.onlyHandler().requests().length === 0) {
    await nextMacrotask();
  }
  if (abortAfterSend) {
    controller.abort();
  }
  return pending;
}

function scripted(): { readonly time: VirtualTimeScheduler; readonly invoker: ScriptedProviderInvoker } {
  const time = new VirtualTimeScheduler({ wallEpochMs: 0, monotonicOriginNs: 5n });
  return { time, invoker: new ScriptedProviderInvoker(time) };
}

describe('ScriptedProviderInvoker conformance', () => {
  it('an aborted in-flight request settles exactly as through the real binding', async () => {
    const real = await realSettlement({ kind: 'hang_until_abort' }, true);
    assert.deepEqual(real, ABORTED_SETTLEMENT);

    const { time, invoker } = scripted();
    invoker.hang();
    const controller = new AbortController();
    const pending = invoker.invoke(PROVIDER_CALL, controller.signal);
    controller.abort();
    assert.deepEqual(await pending, real);
    assert.equal(time.pendingTimerCount(), 0);
  });

  it('an abort before a scheduled settlement cancels it and settles as aborted', async () => {
    const { time, invoker } = scripted();
    invoker.resolveAfter(500n * MS, succeededResponder);
    invoker.rejectAfter(500n * MS, new Error('never'));
    for (let index = 0; index < 2; index += 1) {
      const controller = new AbortController();
      const pending = invoker.invoke(PROVIDER_CALL, controller.signal);
      await time.advanceBy(100);
      controller.abort();
      assert.deepEqual(await pending, ABORTED_SETTLEMENT);
      assert.equal(time.pendingTimerCount(), 0);
    }
  });

  it('a scripted response has exactly the shape the real binding maps from the Invoke output', async () => {
    const payload = jsonBytes({ outcome: 'SUCCEEDED' });
    for (const [http, fake] of [
      [{ kind: 'invoke_response', status: 200, executed_version: '7', payload }, invokeResponse(payload, '7')],
      [
        { kind: 'invoke_response', status: 200, executed_version: '7', function_error: 'Unhandled', payload },
        { ...invokeResponse(payload, '7'), function_error: 'Unhandled' },
      ],
    ] as const) {
      const { time, invoker } = scripted();
      invoker.resolveAfter(0n, () => fake);
      const pending = invoker.invoke(PROVIDER_CALL, new AbortController().signal);
      await time.advanceUntilIdle();
      assert.deepEqual(await pending, await realSettlement(http));
    }
  });

  it('settles each script at its virtual time and records every invocation', async () => {
    const { time, invoker } = scripted();
    invoker.resolveAfter(250n * MS, succeededResponder);
    invoker.rejectAfter(10n * MS, new RangeError('defective port'));
    assert.equal(invoker.pendingScriptCount(), 2);
    const signal = new AbortController().signal;
    let settled = false;
    const first = invoker.invoke(PROVIDER_CALL, signal).finally(() => {
      settled = true;
    });
    await time.advanceBy(249);
    assert.equal(settled, false);
    await time.advanceBy(1);
    assert.deepEqual(await first, succeededResponder(PROVIDER_CALL));
    const second = assert.rejects(invoker.invoke(PROVIDER_CALL, signal), {
      name: 'RangeError',
      message: 'defective port',
    });
    await time.advanceBy(10);
    await second;
    assert.equal(invoker.pendingScriptCount(), 0);
    assert.deepEqual(
      invoker.invocations().map(({ call, signal: seen, invoked_at_ns }) => [call, seen, invoked_at_ns]),
      [
        [PROVIDER_CALL, signal, 5n],
        [PROVIDER_CALL, signal, 5n + 250n * MS],
      ],
    );
  });

  it('resolveAfterAbort ignores the abort and settles its delay after it (RK-04)', async () => {
    const { time, invoker } = scripted();
    invoker.resolveAfterAbort(40n * MS, succeededResponder);
    const controller = new AbortController();
    let settled = false;
    const pending = invoker.invoke(PROVIDER_CALL, controller.signal).finally(() => {
      settled = true;
    });
    await time.advanceBy(5_000);
    assert.equal(settled, false);
    controller.abort();
    await time.advanceBy(39);
    assert.equal(settled, false);
    await time.advanceBy(1);
    assert.deepEqual(await pending, succeededResponder(PROVIDER_CALL));
  });

  it('throwBeforeSend and an unscripted invoke throw synchronously, after recording the call', () => {
    const { invoker } = scripted();
    invoker.throwBeforeSend(new TypeError('bad payload'));
    const signal = new AbortController().signal;
    assert.throws(() => invoker.invoke(PROVIDER_CALL, signal), { name: 'TypeError', message: 'bad payload' });
    assert.throws(() => invoker.invoke(PROVIDER_CALL, signal), {
      message: `unscripted invoke of attempt ${PROVIDER_CALL.attempt_id}; expected a script queued before the call`,
    });
    assert.equal(invoker.invocations().length, 2);
  });

  it('ignoreAbortForever never settles, before or after the abort (RK-04 at its worst)', async () => {
    const { time, invoker } = scripted();
    invoker.ignoreAbortForever();
    const controller = new AbortController();
    let settled = false;
    void invoker.invoke(PROVIDER_CALL, controller.signal).finally(() => {
      settled = true;
    });
    await time.advanceBy(5_000);
    controller.abort();
    await time.advanceBy(600_000);
    await nextMacrotask();
    assert.equal(settled, false);
    assert.equal(time.pendingTimerCount(), 0);
  });

  it('rejectAfter rejects with any value and returnWithoutPromise returns the bare settlement', async () => {
    const { time, invoker } = scripted();
    const nullPrototype: unknown = Object.create(null);
    invoker.rejectAfter(1n * MS, nullPrototype);
    invoker.returnWithoutPromise(succeededResponder);
    const signal = new AbortController().signal;
    const rejected = invoker.invoke(PROVIDER_CALL, signal).then(
      () => 'resolved',
      (reason: unknown) => reason,
    );
    await time.advanceBy(1);
    assert.equal(await rejected, nullPrototype);
    const bare: unknown = invoker.invoke(PROVIDER_CALL, signal);
    assert.equal(bare instanceof Promise, false);
    assert.deepEqual(bare, succeededResponder(PROVIDER_CALL));
  });
});
