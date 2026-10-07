// Conformance of ScriptedXRayClient (design §12.2): its responses are what the SDK's own restJson
// deserializer accepts as X-Ray answers, and its trace list filters as GetTraceSummaries does for
// the probe's request: the traces whose time falls in [StartTime, EndTime], sent as epoch seconds,
// and under a `service("<name>") OR …` filter expression only the traces through a named service.
// No trace exists unless one is put. A search that stops early answers no summary and a
// `NextToken` naming its next page, which a request carrying it continues; a scripted error
// surfaces by its `x-amzn-errortype`.
//
// Sources (RK-17): https://docs.aws.amazon.com/xray/latest/api/API_GetTraceSummaries.html
// (POST /TraceSummaries; StartTime/EndTime are timestamps; FilterExpression "to retrieve trace
// summaries for services or requests that meet certain requirements", e.g. `service("api.example.com")`;
// "If the requested time frame contained more than one page of results, you can use this token to
// retrieve the next page"; ThrottledException 429, InvalidRequestException 400),
// https://docs.aws.amazon.com/xray/latest/devguide/xray-console-filters.html (`service(name)`:
// "Service with name name"; a Lambda function makes two nodes with the function's name, and "a
// standard service filter will find traces for both"; expressions combine with OR) and
// https://docs.aws.amazon.com/xray/latest/devguide/xray-services-lambda.html (a function without
// active tracing records no trace).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GetTraceGraphCommand, GetTraceSummariesCommand } from '@aws-sdk/client-xray';

import { ScriptedXRayClient } from '../../support/evidence-collection/scripted-xray-client.ts';

const START_MS = Date.UTC(2026, 9, 5, 12, 5);
const END_MS = Date.UTC(2026, 9, 5, 12, 20);
const SEARCH = new GetTraceSummariesCommand({ StartTime: new Date(START_MS), EndTime: new Date(END_MS) });

describe('ScriptedXRayClient conformance', () => {
  it('finds no trace when none was recorded', async () => {
    const traces = new ScriptedXRayClient();
    const output = await traces.client.send(SEARCH);
    assert.deepEqual(output.TraceSummaries, []);
    assert.deepEqual(traces.calls(), [
      { operation: 'POST /TraceSummaries', input: { StartTime: START_MS / 1000, EndTime: END_MS / 1000 } },
    ]);
  });

  it('lists the traces inside the inclusive range, decoded by the SDK', async () => {
    const traces = new ScriptedXRayClient();
    traces.putTrace({ id: '1-before', started_ms: START_MS - 1 });
    traces.putTrace({ id: '1-start', started_ms: START_MS });
    traces.putTrace({ id: '1-end', started_ms: END_MS });
    traces.putTrace({ id: '1-after', started_ms: END_MS + 1000 });
    const output = await traces.client.send(SEARCH);
    assert.deepEqual(
      output.TraceSummaries?.map((summary) => summary.Id),
      ['1-start', '1-end'],
    );
  });

  it('answers a search that stopped early with no summary and a continuation token', async () => {
    const traces = new ScriptedXRayClient();
    traces.putTrace({ id: '1-start', started_ms: START_MS });
    traces.stopSearchEarly();
    const output = await traces.client.send(SEARCH);
    assert.deepEqual(output.TraceSummaries, []);
    assert.equal(output.NextToken, 'scripted-next-2');
  });

  it('continues a search with its token, listing the traces once the empty page is read', async () => {
    const traces = new ScriptedXRayClient();
    traces.putTrace({ id: '1-start', started_ms: START_MS });
    traces.stopSearchEarly(1);
    const first = await traces.client.send(SEARCH);
    assert.deepEqual([first.TraceSummaries, first.NextToken], [[], 'scripted-next-2']);
    const second = await traces.client.send(
      new GetTraceSummariesCommand({ ...SEARCH.input, NextToken: first.NextToken }),
    );
    assert.deepEqual(
      second.TraceSummaries?.map((summary) => summary.Id),
      ['1-start'],
    );
    assert.equal(second.NextToken, undefined);
  });

  it('keeps only the traces through a service the filter expression names', async () => {
    const traces = new ScriptedXRayClient();
    traces.putTrace({ id: '1-caller', started_ms: START_MS, services: ['fn-caller'] });
    traces.putTrace({ id: '1-provider', started_ms: START_MS, services: ['other', 'fn-provider'] });
    traces.putTrace({ id: '1-elsewhere', started_ms: START_MS, services: ['another-workload'] });
    traces.putTrace({ id: '1-untraced', started_ms: START_MS });
    const output = await traces.client.send(
      new GetTraceSummariesCommand({
        ...SEARCH.input,
        FilterExpression: 'service("fn-caller") OR service("fn-provider")',
      }),
    );
    assert.deepEqual(
      output.TraceSummaries?.map((summary) => summary.Id),
      ['1-caller', '1-provider'],
    );
    assert.equal(traces.calls()[0]?.input['FilterExpression'], 'service("fn-caller") OR service("fn-provider")');
  });

  it('refuses a filter expression outside the modeled service terms as InvalidRequestException', async () => {
    const traces = new ScriptedXRayClient();
    await assert.rejects(
      traces.client.send(new GetTraceSummariesCommand({ ...SEARCH.input, FilterExpression: 'responsetime > 5' })),
      { name: 'InvalidRequestException' },
    );
  });

  it('fails a scripted error by its type and status, once', async () => {
    const traces = new ScriptedXRayClient();
    traces.scriptError('ThrottledException', 429);
    await assert.rejects(traces.client.send(SEARCH), (error: unknown) => {
      assert.equal((error as Error).name, 'ThrottledException');
      assert.equal((error as { $metadata: { httpStatusCode: number } }).$metadata.httpStatusCode, 429);
      return true;
    });
    assert.deepEqual((await traces.client.send(SEARCH)).TraceSummaries, []);
  });

  it('refuses an operation the probe never sends', async () => {
    const traces = new ScriptedXRayClient();
    await assert.rejects(traces.client.send(new GetTraceGraphCommand({ TraceIds: ['1-a'] })), {
      name: 'UnsupportedOperation',
    });
  });

  it('is pinned to us-east-1 and a single attempt', async () => {
    const traces = new ScriptedXRayClient();
    assert.equal(await traces.client.config.region(), 'us-east-1');
    assert.equal(await traces.client.config.maxAttempts(), 1);
  });
});
