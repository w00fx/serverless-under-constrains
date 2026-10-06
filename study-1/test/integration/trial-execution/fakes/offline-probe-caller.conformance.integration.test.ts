// Conformance of OfflineProbeCaller to the ProbeWorkloadInvoker port (design §9.4, §5.3;
// BR-RUA-027): it runs the real probe caller as its Lambda handler composes it, and answers as the
// Lambda Invoke API does (https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html): a report
// is StatusCode 200 with the report as payload, an unhandled error is StatusCode 200 with
// FunctionError `Unhandled` and `{errorType, errorMessage}`, and the request id is the one the
// caller journals. A scripted result replaces one Invoke without running the caller.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { judgeProbeInvocation } from '../../../../src/trial-execution/probe-invocation.ts';
import type { ProbeWorkloadInvokeResult } from '../../../../src/trial-execution/trial-execution-ports.ts';
import { OFFLINE_PROBE_CALLER_VERSION, OfflineProbeCloud } from '../../../support/offline-cloud/offline-probe-cloud.ts';

const decoder = new TextDecoder();

type InvokeResponse = Extract<ProbeWorkloadInvokeResult, { readonly kind: 'response' }>;

async function preparedProbe(): Promise<OfflineProbeCloud> {
  const cloud = new OfflineProbeCloud();
  await cloud.startExecution();
  return cloud;
}

function response(result: ProbeWorkloadInvokeResult): InvokeResponse {
  assert.equal(result.kind, 'response', JSON.stringify(result));
  return result;
}

describe('OfflineProbeCaller conformance', () => {
  it('runs the real probe caller and answers its report with status 200 and the request id', async () => {
    const cloud = await preparedProbe();
    const plan = cloud.plan();
    const invoking = cloud.caller.invokeWorkload(plan.request);
    let answer: ProbeWorkloadInvokeResult | undefined;
    void invoking.then((result) => {
      answer = result;
    });
    await cloud.advanceUntil(() => answer !== undefined);
    const returned = response(await invoking);
    assert.equal(returned.status_code, 200);
    assert.equal(returned.executed_version, OFFLINE_PROBE_CALLER_VERSION);
    assert.equal(returned.function_error, undefined);
    const report = JSON.parse(decoder.decode(returned.payload)) as Record<string, unknown>;
    assert.equal(report['transport_probe_id'], plan.request.transport_probe_id);
    assert.equal(report['lambda_request_id'], returned.request_id);
    assert.deepEqual(judgeProbeInvocation(returned, plan), {
      kind: 'started',
      invoked: {
        lambda_request_id: returned.request_id,
        status_code: 200,
        executed_version: OFFLINE_PROBE_CALLER_VERSION,
      },
      invocation_returned: true,
      failures: [],
    });
    assert.deepEqual(cloud.caller.requests(), [plan.request]);
  });

  it('answers a fault of the caller as an unhandled function error with its type and message', async () => {
    const cloud = await preparedProbe();
    const request = { ...cloud.plan().request, amount_minor: -1 };
    const returned = response(await cloud.caller.invokeWorkload(request));
    assert.equal(returned.status_code, 200);
    assert.equal(returned.function_error, 'Unhandled');
    assert.ok(returned.request_id !== undefined);
    const payload = JSON.parse(decoder.decode(returned.payload)) as Record<string, unknown>;
    assert.equal(typeof payload['errorType'], 'string');
    assert.match(String(payload['errorMessage']), /.+/u);
  });

  it('settles one scripted Invoke as given without running the caller', async () => {
    const cloud = await preparedProbe();
    const scripted = { kind: 'rejected', code: 'ResourceNotFoundException', detail: 'scripted' } as const;
    cloud.caller.scriptNext(scripted);
    const request = { ...cloud.plan().request, amount_minor: -1 };
    assert.deepEqual(await cloud.caller.invokeWorkload(request), scripted);
    assert.equal(response(await cloud.caller.invokeWorkload(request)).function_error, 'Unhandled');
    assert.equal(cloud.caller.requests().length, 2);
  });
});
