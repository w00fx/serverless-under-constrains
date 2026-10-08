// Conformance of ScriptedCloudWatchClient (design §12.2): its responses are what the SDK's own
// awsJson1_0 deserializer accepts as CloudWatch answers, and its metric list filters as
// ListMetrics does for the probe's request: the namespace, the metric name and every requested
// dimension must match exactly. A listing that stops early answers no metric and a `NextToken`;
// a scripted error surfaces by its type.
//
// Sources (RK-17): https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_ListMetrics.html
// (Dimensions: "the dimensions to filter against. Only the dimensions that match exactly will be
// returned"; "up to 500 results are returned for any one call ... use the NextToken"; errors
// InvalidParameterValue, InternalServiceFault).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DescribeAlarmsCommand, ListMetricsCommand } from '@aws-sdk/client-cloudwatch';

import { ScriptedCloudWatchClient } from '../../support/evidence-collection/scripted-cloudwatch-client.ts';
import type { ScriptedMetric } from '../../support/evidence-collection/scripted-cloudwatch-client.ts';

const FUNCTION = 'SucRua-run-RefundProviderFn';

function invocations(functionName: string): ScriptedMetric {
  return {
    Namespace: 'AWS/Lambda',
    MetricName: 'Invocations',
    Dimensions: [{ Name: 'FunctionName', Value: functionName }],
  };
}

const LIST_INVOCATIONS = new ListMetricsCommand({
  Namespace: 'AWS/Lambda',
  MetricName: 'Invocations',
  Dimensions: [{ Name: 'FunctionName', Value: FUNCTION }],
});

describe('ScriptedCloudWatchClient conformance', () => {
  it('lists only the metrics matching namespace, name and every dimension, decoded by the SDK', async () => {
    const metrics = new ScriptedCloudWatchClient();
    metrics.putMetric(invocations(FUNCTION));
    metrics.putMetric(invocations('other'));
    metrics.putMetric({ ...invocations(FUNCTION), MetricName: 'Errors' });
    metrics.putMetric({ ...invocations(FUNCTION), Namespace: 'AWS/SQS' });
    const output = await metrics.client.send(LIST_INVOCATIONS);
    assert.deepEqual(output.Metrics, [invocations(FUNCTION)]);
    assert.equal(output.NextToken, undefined);
    assert.deepEqual(metrics.calls(), [
      {
        operation: 'ListMetrics',
        input: {
          Namespace: 'AWS/Lambda',
          MetricName: 'Invocations',
          Dimensions: [{ Name: 'FunctionName', Value: FUNCTION }],
        },
      },
    ]);
  });

  it('lists every metric of the namespace and name when no dimension is requested', async () => {
    const metrics = new ScriptedCloudWatchClient();
    metrics.putMetric(invocations(FUNCTION));
    metrics.putMetric(invocations('other'));
    const output = await metrics.client.send(
      new ListMetricsCommand({ Namespace: 'AWS/Lambda', MetricName: 'Invocations' }),
    );
    assert.equal(output.Metrics?.length, 2);
  });

  it('answers a listing that stopped early with no metric and a continuation token', async () => {
    const metrics = new ScriptedCloudWatchClient();
    metrics.putMetric(invocations(FUNCTION));
    metrics.stopListingEarly();
    const output = await metrics.client.send(LIST_INVOCATIONS);
    assert.deepEqual(output.Metrics, []);
    assert.equal(output.NextToken, 'scripted-next');
  });

  it('fails a scripted error by its type, once', async () => {
    const metrics = new ScriptedCloudWatchClient();
    metrics.scriptError('InvalidParameterValueException');
    await assert.rejects(metrics.client.send(LIST_INVOCATIONS), { name: 'InvalidParameterValueException' });
    assert.deepEqual((await metrics.client.send(LIST_INVOCATIONS)).Metrics, []);
  });

  it('refuses an operation the probe never sends', async () => {
    const metrics = new ScriptedCloudWatchClient();
    await assert.rejects(metrics.client.send(new DescribeAlarmsCommand({})), { name: 'UnsupportedOperation' });
  });

  it('is pinned to us-east-1 and a single attempt', async () => {
    const metrics = new ScriptedCloudWatchClient();
    assert.equal(await metrics.client.config.region(), 'us-east-1');
    assert.equal(await metrics.client.config.maxAttempts(), 1);
  });
});
