// Conformance of ScriptedCloudWatchLogsClient (design §12.2): its responses are what the SDK's own
// awsJson1_1 deserializer accepts as CloudWatch Logs answers, and its log-group model filters as
// FilterLogEvents does for the probe's request: the quoted term as an exact phrase, the time range
// with both ends included, at most `limit` events, an unknown group as ResourceNotFoundException.
// A search that stops early answers no event and a `nextToken`.
//
// Sources (RK-17): https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_FilterLogEvents.html
// (startTime/endTime: "events with a timestamp before this time are not returned" / "later than
// this time are not returned"; limit; "this operation can return empty results while there are
// more log events available through the token"; ResourceNotFoundException) and
// https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/FilterAndPatternSyntax.html (a quoted
// term matches the exact phrase).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudwatch-logs';

import { ScriptedCloudWatchLogsClient } from '../../support/evidence-collection/scripted-cloudwatch-logs-client.ts';

const GROUP = '/suc/study-1/run/refund-provider';
const TERM = '5f0c8a3e-0000-4000-8000-000000000001';

function search(startTime: number, endTime: number, limit = 10): FilterLogEventsCommand {
  return new FilterLogEventsCommand({ logGroupName: GROUP, filterPattern: `"${TERM}"`, startTime, endTime, limit });
}

describe('ScriptedCloudWatchLogsClient conformance', () => {
  it('returns the matching events inside the inclusive range, decoded by the SDK', async () => {
    const logs = new ScriptedCloudWatchLogsClient();
    logs.putEvent(GROUP, { timestamp: 100, message: `before ${TERM}` });
    logs.putEvent(GROUP, { timestamp: 200, message: `start ${TERM}` });
    logs.putEvent(GROUP, { timestamp: 250, message: 'another trial' });
    logs.putEvent(GROUP, { timestamp: 300, message: `end ${TERM}` });
    logs.putEvent(GROUP, { timestamp: 301, message: `after ${TERM}` });
    const output = await logs.client.send(search(200, 300));
    assert.deepEqual(
      output.events?.map((event) => [event.timestamp, event.message]),
      [
        [200, `start ${TERM}`],
        [300, `end ${TERM}`],
      ],
    );
    assert.equal(output.nextToken, undefined);
    assert.deepEqual(logs.calls(), [
      {
        operation: 'FilterLogEvents',
        input: { logGroupName: GROUP, filterPattern: `"${TERM}"`, startTime: 200, endTime: 300, limit: 10 },
      },
    ]);
  });

  it('returns at most limit events, and none for an empty group', async () => {
    const logs = new ScriptedCloudWatchLogsClient();
    logs.putEvent(GROUP, { timestamp: 200, message: TERM });
    logs.putEvent(GROUP, { timestamp: 201, message: TERM });
    assert.equal((await logs.client.send(search(0, 1000, 1))).events?.length, 1);
    const empty = new ScriptedCloudWatchLogsClient();
    empty.createGroup(GROUP);
    assert.deepEqual((await empty.client.send(search(0, 1000))).events, []);
  });

  it('answers a search that stopped early with no event and a continuation token', async () => {
    const logs = new ScriptedCloudWatchLogsClient();
    logs.putEvent(GROUP, { timestamp: 200, message: TERM });
    logs.stopSearchEarly(GROUP);
    const output = await logs.client.send(search(0, 1000));
    assert.deepEqual(output.events, []);
    assert.equal(output.nextToken, 'scripted-next');
  });

  it('fails an unknown group as the SDK class and a scripted error by its type, once', async () => {
    const logs = new ScriptedCloudWatchLogsClient();
    await assert.rejects(
      logs.client.send(search(0, 1)),
      (error: unknown) => error instanceof ResourceNotFoundException,
    );
    logs.createGroup(GROUP);
    logs.scriptError('ThrottlingException');
    await assert.rejects(logs.client.send(search(0, 1)), { name: 'ThrottlingException' });
    assert.deepEqual((await logs.client.send(search(0, 1))).events, []);
  });

  it('refuses an operation the probe never sends', async () => {
    const logs = new ScriptedCloudWatchLogsClient();
    await assert.rejects(logs.client.send(new DescribeLogGroupsCommand({})), { name: 'UnsupportedOperation' });
  });

  it('is pinned to us-east-1 and a single attempt', async () => {
    const logs = new ScriptedCloudWatchLogsClient();
    assert.equal(await logs.client.config.region(), 'us-east-1');
    assert.equal(await logs.client.config.maxAttempts(), 1);
  });
});
