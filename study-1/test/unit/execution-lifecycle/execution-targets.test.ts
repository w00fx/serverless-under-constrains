// The deployed stack's targets, read from the frozen resource manifest (design §9.2, §9.8 D2-D4):
// the output keys match the execution stack's, a variant is deployed only with both queue URLs, and
// the Durable caller needs its function ARN and the alias ARN under it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_STACK_OUTPUTS } from '../../../infra/stacks/execution-stack.ts';
import {
  STACK_OUTPUT_KEYS,
  executionTargetsOf,
  queueNameOf,
  recordedEventSourceMappings,
} from '../../../src/execution-lifecycle/execution-targets.ts';
import type {
  KeyValueEntry,
  ResourceManifest,
} from '../../../src/record-contract/records/group-a/resource_manifest.ts';
import { ACCOUNT_SQS_HOST, NAMES, resourceManifest } from '../../support/cleanup/cleanup-fixtures.ts';

const SOURCE = `${ACCOUNT_SQS_HOST}/suc1-aaaaaaaa-conventional-source.fifo`;
const DLQ = `${ACCOUNT_SQS_HOST}/suc1-aaaaaaaa-conventional-dlq.fifo`;
const DURABLE_SOURCE = `${ACCOUNT_SQS_HOST}/suc1-aaaaaaaa-durable-source.fifo`;
const DURABLE_DLQ = `${ACCOUNT_SQS_HOST}/suc1-aaaaaaaa-durable-dlq.fifo`;
const CALLER_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:suc1-aaaaaaaa-durable-caller';

function withOutputs(outputs: readonly KeyValueEntry[], manifest = resourceManifest()): ResourceManifest {
  return { ...manifest, outputs };
}

function out(key: string, value: string): KeyValueEntry {
  return { key, value };
}

const FULL: readonly KeyValueEntry[] = [
  out(STACK_OUTPUT_KEYS.conventionalSourceQueueUrl, SOURCE),
  out(STACK_OUTPUT_KEYS.conventionalDeadLetterQueueUrl, DLQ),
  out(STACK_OUTPUT_KEYS.durableSourceQueueUrl, DURABLE_SOURCE),
  out(STACK_OUTPUT_KEYS.durableDeadLetterQueueUrl, DURABLE_DLQ),
  out(STACK_OUTPUT_KEYS.durableCallerFunctionName, 'suc1-aaaaaaaa-durable-caller'),
  out(STACK_OUTPUT_KEYS.durableCallerFunctionArn, CALLER_ARN),
  out(STACK_OUTPUT_KEYS.durableCallerAliasArn, `${CALLER_ARN}:live`),
];

describe('STACK_OUTPUT_KEYS', () => {
  it('spells every key exactly as the execution stack declares it', () => {
    for (const [name, key] of Object.entries(STACK_OUTPUT_KEYS)) {
      assert.equal(EXECUTION_STACK_OUTPUTS[name as keyof typeof EXECUTION_STACK_OUTPUTS], key, name);
    }
  });
});

describe('executionTargetsOf', () => {
  it('reads both variants, the Durable caller and the mappings of a succeeded deploy', () => {
    const targets = executionTargetsOf(withOutputs(FULL));
    assert.deepEqual(targets, {
      ok: true,
      value: {
        provider_version: '1',
        queues: {
          conventional: {
            source: { queue_url: SOURCE, queue_name: 'suc1-aaaaaaaa-conventional-source.fifo' },
            dlq: { queue_url: DLQ, queue_name: 'suc1-aaaaaaaa-conventional-dlq.fifo' },
          },
          durable: {
            source: { queue_url: DURABLE_SOURCE, queue_name: 'suc1-aaaaaaaa-durable-source.fifo' },
            dlq: { queue_url: DURABLE_DLQ, queue_name: 'suc1-aaaaaaaa-durable-dlq.fifo' },
          },
        },
        durable_caller: { function_arn: CALLER_ARN, qualifier: 'live' },
        event_source_mapping_ids: [NAMES.sourceMapping],
        durable_function_names: ['suc1-aaaaaaaa-durable-caller'],
        function_names: { 'durable-caller': 'suc1-aaaaaaaa-durable-caller' },
      },
    });
  });

  it('reads the provider, the probe caller and every function telemetry looks up', () => {
    const targets = executionTargetsOf(
      withOutputs([
        out(STACK_OUTPUT_KEYS.providerFunctionName, 'suc1-aaaaaaaa-refund-provider'),
        out(STACK_OUTPUT_KEYS.controllerFunctionName, 'suc1-aaaaaaaa-treatment-controller'),
        out(STACK_OUTPUT_KEYS.probeCallerFunctionName, 'suc1-aaaaaaaa-probe-caller'),
        out(STACK_OUTPUT_KEYS.probeCallerVersion, '12'),
        out(STACK_OUTPUT_KEYS.conventionalCallerFunctionName, 'suc1-aaaaaaaa-conventional-caller'),
      ]),
    );
    assert.equal(targets.ok, true);
    assert.equal(targets.value.provider_function_name, 'suc1-aaaaaaaa-refund-provider');
    assert.deepEqual(targets.value.probe_caller, { function_name: 'suc1-aaaaaaaa-probe-caller', version: '12' });
    assert.deepEqual(targets.value.function_names, {
      'conventional-caller': 'suc1-aaaaaaaa-conventional-caller',
      'probe-caller': 'suc1-aaaaaaaa-probe-caller',
      'refund-provider': 'suc1-aaaaaaaa-refund-provider',
      'treatment-controller': 'suc1-aaaaaaaa-treatment-controller',
    });
  });

  it('leaves out the provider name and the probe caller a stack does not output', () => {
    const targets = executionTargetsOf(withOutputs([]));
    assert.equal(targets.ok, true);
    assert.equal(Object.hasOwn(targets.value, 'provider_function_name'), false);
    assert.equal(Object.hasOwn(targets.value, 'probe_caller'), false);
    assert.deepEqual(targets.value.function_names, {});
  });

  for (const [name, outputs] of [
    ['a probe caller name without its version', [out(STACK_OUTPUT_KEYS.probeCallerFunctionName, 'f')]],
    ['a probe caller version without its name', [out(STACK_OUTPUT_KEYS.probeCallerVersion, '3')]],
    [
      'an empty probe caller name',
      [out(STACK_OUTPUT_KEYS.probeCallerFunctionName, ''), out(STACK_OUTPUT_KEYS.probeCallerVersion, '3')],
    ],
    [
      'the unpublished $LATEST version',
      [out(STACK_OUTPUT_KEYS.probeCallerFunctionName, 'f'), out(STACK_OUTPUT_KEYS.probeCallerVersion, '$LATEST')],
    ],
    [
      'a version with a leading zero',
      [out(STACK_OUTPUT_KEYS.probeCallerFunctionName, 'f'), out(STACK_OUTPUT_KEYS.probeCallerVersion, '07')],
    ],
    [
      'a version followed by text',
      [out(STACK_OUTPUT_KEYS.probeCallerFunctionName, 'f'), out(STACK_OUTPUT_KEYS.probeCallerVersion, '7a')],
    ],
  ] as const) {
    it(`refuses ${name}`, () => {
      const targets = executionTargetsOf(withOutputs(outputs));
      assert.equal(targets.ok, false);
      assert.match(targets.error.detail, /probe caller outputs are .*expected a function name and a published version/);
    });
  }

  it('reports the first unresolved group: queues before the Durable caller before the probe caller', () => {
    const broken = [FULL[0], FULL[6], out(STACK_OUTPUT_KEYS.probeCallerVersion, '3')] as readonly KeyValueEntry[];
    const queues = executionTargetsOf(withOutputs(broken));
    assert.equal(queues.ok, false);
    assert.match(queues.error.detail, /conventional queue outputs/);
    const durableQueues = executionTargetsOf(withOutputs([FULL[3], FULL[6]] as readonly KeyValueEntry[]));
    assert.equal(durableQueues.ok, false);
    assert.match(durableQueues.error.detail, /durable queue outputs/);
    const caller = executionTargetsOf(withOutputs(broken.slice(1)));
    assert.equal(caller.ok, false);
    assert.match(caller.error.detail, /Durable caller outputs/);
  });

  it('leaves out a variant and the caller the stack did not deploy', () => {
    const targets = executionTargetsOf(withOutputs(FULL.slice(0, 2)));
    assert.equal(targets.ok, true);
    assert.deepEqual(Object.keys(targets.value.queues), ['conventional']);
    assert.equal(targets.value.durable_caller, undefined);
    assert.deepEqual(targets.value.durable_function_names, []);
  });

  it('refuses a deploy that did not succeed', () => {
    const targets = executionTargetsOf(resourceManifest('partial'));
    assert.equal(targets.ok, false);
    assert.equal(targets.error.code, 'EXECUTION_TARGETS_UNRESOLVED');
    assert.match(targets.error.detail, /provisioning is partial; expected a succeeded deploy/);
  });

  for (const [name, outputs] of [
    ['conventional source without its DLQ', [FULL[0]]],
    ['durable DLQ without its source', [FULL[3]]],
    [
      'a queue URL without a name',
      [FULL[0], out(STACK_OUTPUT_KEYS.conventionalDeadLetterQueueUrl, `${ACCOUNT_SQS_HOST}/`)],
    ],
    ['a source URL without a name', [out(STACK_OUTPUT_KEYS.durableSourceQueueUrl, `${ACCOUNT_SQS_HOST}/`), FULL[3]]],
  ] as const) {
    it(`refuses ${name}`, () => {
      const targets = executionTargetsOf(withOutputs(outputs as readonly KeyValueEntry[]));
      assert.equal(targets.ok, false);
      assert.match(targets.error.detail, /queue outputs are .*expected both queue URLs/);
      assert.equal(targets.error.subject, 'BR-RUA-040');
    });
  }

  for (const [name, outputs] of [
    ['an alias without the function ARN', [FULL[6]]],
    ['a function ARN without an alias', [FULL[5]]],
    ['an alias of another function', [FULL[5], out(STACK_OUTPUT_KEYS.durableCallerAliasArn, `${CALLER_ARN}x:live`)]],
    ['an empty alias name', [FULL[5], out(STACK_OUTPUT_KEYS.durableCallerAliasArn, `${CALLER_ARN}:`)]],
    ['an alias name with a colon', [FULL[5], out(STACK_OUTPUT_KEYS.durableCallerAliasArn, `${CALLER_ARN}:a:b`)]],
  ] as const) {
    it(`refuses ${name}`, () => {
      const targets = executionTargetsOf(withOutputs(outputs as readonly KeyValueEntry[]));
      assert.equal(targets.ok, false);
      assert.match(targets.error.detail, /Durable caller outputs are .*<function-arn>:<alias>/);
    });
  }
});

describe('recordedEventSourceMappings', () => {
  it('lists only mappings that have a physical id', () => {
    const manifest = resourceManifest();
    const unassigned = {
      ...manifest,
      resources: [
        ...manifest.resources,
        { logical_id: 'Pending', resource_type: 'AWS::Lambda::EventSourceMapping', resource_status: 'CREATE_FAILED' },
      ],
    };
    assert.deepEqual(recordedEventSourceMappings(unassigned), [NAMES.sourceMapping]);
  });
});

describe('queueNameOf', () => {
  it('is the last path segment of the URL', () => {
    assert.equal(queueNameOf(`${ACCOUNT_SQS_HOST}/q.fifo`), 'q.fifo');
    assert.equal(queueNameOf('q.fifo'), 'q.fifo');
  });
});
