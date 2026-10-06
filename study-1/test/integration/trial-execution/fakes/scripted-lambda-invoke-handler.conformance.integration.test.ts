// Conformance of ScriptedLambdaInvokeHandler to Lambda Invoke on the wire
// (https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html), as the real SDK reads it: the
// status is StatusCode, X-Amz-Executed-Version and X-Amz-Function-Error are ExecutedVersion and
// FunctionError, the body is Payload, x-amzn-RequestId is `$metadata.requestId`, and an error
// answer deserializes into the service exception named by X-Amzn-ErrorType with its fault and
// HTTP status.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InvokeCommand } from '@aws-sdk/client-lambda';

import { createProviderLambdaClient } from '../../../../src/provider-client/aws/provider-lambda-client.ts';
import { ScriptedLambdaInvokeHandler } from '../support/scripted-lambda-invoke-handler.ts';
import { serviceException } from '../support/service-exception.ts';

const CREDENTIALS = { accessKeyId: 'AKIDCONFORMANCE', secretAccessKey: 'not-a-secret' };
const COMMAND_INPUT = { FunctionName: 'f', Qualifier: '1', InvocationType: 'RequestResponse' as const };

describe('ScriptedLambdaInvokeHandler conformance', () => {
  it('answers with the Invoke output members and the request id', async () => {
    const http = new ScriptedLambdaInvokeHandler();
    const client = createProviderLambdaClient(http.factory, { credentials: CREDENTIALS });
    const payload = new TextEncoder().encode('{"ok":true}');
    http.script({
      kind: 'invoke_response',
      status: 200,
      request_id: 'req-9',
      executed_version: '1',
      function_error: 'Unhandled',
      payload,
    });
    const output = await client.send(new InvokeCommand({ ...COMMAND_INPUT, Payload: payload }));
    assert.equal(output.StatusCode, 200);
    assert.equal(output.ExecutedVersion, '1');
    assert.equal(output.FunctionError, 'Unhandled');
    assert.equal(output.$metadata.requestId, 'req-9');
    assert.deepEqual(Uint8Array.from(output.Payload ?? []), payload);
    assert.deepEqual(http.requests()[0]?.body, payload);
  });

  it('answers errors as service exceptions with their fault and status', async () => {
    const http = new ScriptedLambdaInvokeHandler();
    const client = createProviderLambdaClient(http.factory, { credentials: CREDENTIALS });
    http.script({ kind: 'service_error', status: 429, type: 'TooManyRequestsException' });
    http.script({ kind: 'service_error', status: 500, type: 'ServiceException', request_id: 'req-5' });
    await assert.rejects(
      client.send(new InvokeCommand(COMMAND_INPUT)),
      serviceException('TooManyRequestsException', 'client', 429),
    );
    await assert.rejects(
      client.send(new InvokeCommand(COMMAND_INPUT)),
      serviceException('ServiceException', 'server', 500, 'req-5'),
    );
  });

  it('rejects with the scripted network error, and without a script', async () => {
    const http = new ScriptedLambdaInvokeHandler();
    const client = createProviderLambdaClient(http.factory, { credentials: CREDENTIALS });
    http.script({ kind: 'network_error', error: new Error('socket hang up') });
    await assert.rejects(client.send(new InvokeCommand(COMMAND_INPUT)), { message: 'socket hang up' });
    await assert.rejects(client.send(new InvokeCommand(COMMAND_INPUT)), /no scripted answer/);
  });
});
