// The total mappers from raw SDK outputs to post-deploy readings (design §9.8 D4; A-05): each reads
// own members only, records an absent member as null and a present one as exact JSON, and turns any
// answer that does not fit into a `<Operation>OutputMalformed` failure naming the member and the
// expected shape. Also the paged resource listing over the reader port, and its bounds.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  absentProvisionedConcurrency,
  eventSourceMappingOf,
  functionConfigurationOf,
  isMissingStack,
  listAllStackResources,
  MAX_RESOURCE_PAGES,
  provisionedConcurrencyOf,
  queueAttributesOf,
  stackDescriptionOf,
  stackReadReason,
  stackResourcePageOf,
  tableDescriptionOf,
} from '../../../src/deployment-assembly/post-deploy-reading.ts';
import { declaredTags, RUN_STACK } from '../../support/deployment-assembly/deployment-fixtures.ts';
import { deployedAccount, stackIdOf } from '../../support/deployment-assembly/deployed-account.ts';
import { runTemplate } from '../../support/deployment-assembly/execution-template-fixture.ts';
import { FakePostDeployReader, pageToken } from '../../support/deployment-assembly/fake-post-deploy-reader.ts';
import { DEEP_NESTING, parsedTower } from '../../support/kernel/deep-json.ts';

const STACK_ID = stackIdOf(RUN_STACK);
const SUMMARY = {
  LogicalResourceId: 'Queue',
  ResourceType: 'AWS::SQS::Queue',
  PhysicalResourceId: 'https://sqs.us-east-1.amazonaws.com/123456789012/q',
  ResourceStatus: 'CREATE_COMPLETE',
};

function failureCode(result: { readonly ok: boolean; readonly error?: { readonly code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

describe('stackDescriptionOf', () => {
  it('maps exactly one stack with its id, status and string tags', () => {
    assert.deepEqual(
      stackDescriptionOf({
        Stacks: [{ StackId: STACK_ID, StackStatus: 'CREATE_COMPLETE', Tags: [{ Key: 'k', Value: 'v' }] }],
      }),
      { ok: true, value: { stack_id: STACK_ID, stack_status: 'CREATE_COMPLETE', tags: [{ key: 'k', value: 'v' }] } },
    );
    assert.deepEqual(stackDescriptionOf({ Stacks: [{ StackId: STACK_ID, StackStatus: 'CREATE_COMPLETE' }] }), {
      ok: true,
      value: { stack_id: STACK_ID, stack_status: 'CREATE_COMPLETE', tags: [] },
    });
  });

  it('refuses no stack, two stacks, a missing id or status, and malformed tags', () => {
    const stack = { StackId: STACK_ID, StackStatus: 'CREATE_COMPLETE' };
    const refused = [
      {},
      { Stacks: 'x' },
      { Stacks: [] },
      { Stacks: [stack, stack] },
      { Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] },
      { Stacks: [{ StackId: STACK_ID, StackStatus: '' }] },
      { Stacks: [{ ...stack, Tags: 'x' }] },
      { Stacks: [{ ...stack, Tags: [{ Key: 'k', Value: 1 }] }] },
      { Stacks: [{ ...stack, Tags: [{ Value: 'v' }] }] },
      Object.create({ Stacks: [stack] }) as object,
    ];
    for (const output of refused) {
      assert.equal(failureCode(stackDescriptionOf(output)), 'DescribeStacksOutputMalformed', JSON.stringify(output));
    }
    const detail = stackDescriptionOf({ Stacks: [] });
    assert.match(detail.ok ? '' : detail.error.detail, /expected exactly one stack with a StackId and a StackStatus/);
  });
});

describe('isMissingStack', () => {
  it('recognizes only the ValidationError that names the stack as absent', () => {
    assert.equal(
      isMissingStack({ code: 'ValidationError', detail: `Stack with id ${RUN_STACK} does not exist` }, RUN_STACK),
      true,
    );
    assert.equal(
      isMissingStack({ code: 'ValidationError', detail: 'Stack with id other does not exist' }, RUN_STACK),
      false,
    );
    assert.equal(
      isMissingStack({ code: 'Throttling', detail: `Stack with id ${RUN_STACK} does not exist` }, RUN_STACK),
      false,
    );
  });
});

describe('stackResourcePageOf', () => {
  it('maps summaries and the next token, with an optional physical id', () => {
    const { PhysicalResourceId: _omitted, ...withoutPhysical } = SUMMARY;
    assert.deepEqual(stackResourcePageOf({ StackResourceSummaries: [SUMMARY, withoutPhysical], NextToken: 't' }), {
      ok: true,
      value: {
        resources: [
          {
            logical_id: 'Queue',
            resource_type: 'AWS::SQS::Queue',
            physical_id: SUMMARY.PhysicalResourceId,
            resource_status: 'CREATE_COMPLETE',
          },
          { logical_id: 'Queue', resource_type: 'AWS::SQS::Queue', resource_status: 'CREATE_COMPLETE' },
        ],
        next_token: 't',
      },
    });
    assert.deepEqual(stackResourcePageOf({ StackResourceSummaries: [] }), { ok: true, value: { resources: [] } });
  });

  it('refuses a missing list, a malformed summary and an empty or non-string token', () => {
    const refused = [
      {},
      { StackResourceSummaries: [{ ...SUMMARY, LogicalResourceId: 1 }] },
      { StackResourceSummaries: [{ ...SUMMARY, ResourceType: undefined }] },
      { StackResourceSummaries: [{ ...SUMMARY, ResourceStatus: null }] },
      { StackResourceSummaries: [{ ...SUMMARY, PhysicalResourceId: 7 }] },
      { StackResourceSummaries: [], NextToken: '' },
      { StackResourceSummaries: [], NextToken: 3 },
    ];
    for (const output of refused) {
      assert.equal(
        failureCode(stackResourcePageOf(output)),
        'ListStackResourcesOutputMalformed',
        JSON.stringify(output),
      );
    }
  });
});

describe('functionConfigurationOf', () => {
  it('records the configuration, absent members as null, and the sorted variable names only', () => {
    assert.deepEqual(
      functionConfigurationOf({
        Runtime: 'nodejs24.x',
        Architectures: ['arm64'],
        MemorySize: 256,
        Version: '3',
        Environment: { Variables: { SECRET_B: 'value-b', A: 'value-a' } },
      }),
      {
        ok: true,
        value: [
          { attribute_path: 'Runtime', value: 'nodejs24.x' },
          { attribute_path: 'Architectures', value: ['arm64'] },
          { attribute_path: 'MemorySize', value: 256 },
          { attribute_path: 'Timeout', value: null },
          { attribute_path: 'Version', value: '3' },
          { attribute_path: 'EnvironmentKeys', value: ['A', 'SECRET_B'] },
        ],
      },
    );
    const bare = functionConfigurationOf({});
    assert.deepEqual(bare.ok && bare.value.at(-1), { attribute_path: 'EnvironmentKeys', value: [] });
  });

  it('refuses non-finite numbers, non-JSON members and malformed variables', () => {
    const refused = [
      { MemorySize: Number.POSITIVE_INFINITY },
      { Timeout: Number.NaN },
      { Runtime: new Date(0) },
      { Version: 1n },
      { Environment: { Variables: ['A'] } },
      { Environment: { Variables: 'A=1' } },
      { Environment: { Variables: null } },
    ];
    for (const output of refused) {
      assert.equal(failureCode(functionConfigurationOf(output)), 'GetFunctionConfigurationOutputMalformed');
    }
    const detail = functionConfigurationOf({ MemorySize: Number.POSITIVE_INFINITY });
    assert.match(detail.ok ? '' : detail.error.detail, /^MemorySize .*; expected a finite JSON value$/);
  });

  it('reads own members only, never inherited ones', () => {
    const inherited = Object.create({ Runtime: 'nodejs24.x', Version: '7' }) as object;
    const read = functionConfigurationOf(inherited);
    assert.deepEqual(read.ok && read.value.slice(0, 1), [{ attribute_path: 'Runtime', value: null }]);
    const read2 = functionConfigurationOf({ Environment: { Variables: Object.create({ HIDDEN: '1' }) as object } });
    assert.deepEqual(read2.ok && read2.value.at(-1), { attribute_path: 'EnvironmentKeys', value: [] });
    const named = functionConfigurationOf(JSON.parse('{"__proto__":{"Runtime":"x"},"constructor":"y"}') as object);
    assert.deepEqual(named.ok && named.value[0], { attribute_path: 'Runtime', value: null });
  });
});

describe('eventSourceMappingOf, queueAttributesOf, tableDescriptionOf', () => {
  it('records the mapping settings and state, absent ones as null', () => {
    const read = eventSourceMappingOf({ State: 'Enabled', BatchSize: 1, ScalingConfig: { MaximumConcurrency: 2 } });
    assert.ok(read.ok);
    const byPath = new Map(read.value.map((reading) => [reading.attribute_path, reading.value]));
    assert.equal(byPath.get('State'), 'Enabled');
    assert.deepEqual(byPath.get('ScalingConfig'), { MaximumConcurrency: 2 });
    assert.equal(byPath.get('DestinationConfig'), null);
    assert.equal(read.value.length, 14);
    assert.equal(
      failureCode(eventSourceMappingOf({ LastModified: new Date(0), State: new Date(0) })),
      'GetEventSourceMappingOutputMalformed',
    );
  });

  it('records queue attributes as strings and refuses any other value', () => {
    assert.deepEqual(queueAttributesOf({ Attributes: { FifoQueue: 'true', VisibilityTimeout: '60' } }), {
      ok: true,
      value: [
        { attribute_path: 'FifoQueue', value: 'true' },
        { attribute_path: 'ContentBasedDeduplication', value: null },
        { attribute_path: 'VisibilityTimeout', value: '60' },
        { attribute_path: 'RedrivePolicy', value: null },
      ],
    });
    const refused = queueAttributesOf({ Attributes: { VisibilityTimeout: 60 } });
    assert.deepEqual(refused, {
      ok: false,
      error: { code: 'GetQueueAttributesOutputMalformed', detail: 'VisibilityTimeout 60; expected a string' },
    });
    assert.equal(
      failureCode(queueAttributesOf({ Attributes: { FifoQueue: Number.NaN } })),
      'GetQueueAttributesOutputMalformed',
    );
    // Fuzz seed 672990290: a JSON null attribute records exactly as an absent one.
    const nulled = queueAttributesOf({ Attributes: { FifoQueue: null } });
    assert.deepEqual(nulled.ok && nulled.value[0], { attribute_path: 'FifoQueue', value: null });
  });

  it('records the table stream specification and billing mode', () => {
    assert.deepEqual(tableDescriptionOf({ Table: { BillingModeSummary: { BillingMode: 'PROVISIONED' } } }), {
      ok: true,
      value: [
        { attribute_path: 'StreamSpecification', value: null },
        { attribute_path: 'BillingModeSummary.BillingMode', value: 'PROVISIONED' },
      ],
    });
    assert.equal(
      failureCode(tableDescriptionOf({ Table: { StreamSpecification: { x: Number.NEGATIVE_INFINITY } } })),
      'DescribeTableOutputMalformed',
    );
  });
});

describe('provisioned concurrency readings', () => {
  it('records a configuration that exists as one object, and an absent one as null', () => {
    assert.deepEqual(provisionedConcurrencyOf({ RequestedProvisionedConcurrentExecutions: 1, Status: 'READY' }), {
      ok: true,
      value: [
        {
          attribute_path: 'ProvisionedConcurrencyConfig',
          value: {
            RequestedProvisionedConcurrentExecutions: 1,
            AllocatedProvisionedConcurrentExecutions: null,
            AvailableProvisionedConcurrentExecutions: null,
            Status: 'READY',
          },
        },
      ],
    });
    assert.deepEqual(absentProvisionedConcurrency(), [{ attribute_path: 'ProvisionedConcurrencyConfig', value: null }]);
    assert.equal(
      failureCode(provisionedConcurrencyOf({ Status: Number.POSITIVE_INFINITY })),
      'GetProvisionedConcurrencyConfigOutputMalformed',
    );
  });
});

describe('hostile outputs (A-05)', () => {
  it('maps a 100,000-level member without throwing', () => {
    const tower = parsedTower('mixed', DEEP_NESTING);
    const mapping = eventSourceMappingOf({ ScalingConfig: tower });
    assert.equal(typeof mapping.ok, 'boolean');
    const table = tableDescriptionOf({ Table: { StreamSpecification: tower } });
    assert.equal(typeof table.ok, 'boolean');
    const page = stackResourcePageOf({ StackResourceSummaries: [tower] });
    assert.equal(failureCode(page), 'ListStackResourcesOutputMalformed');
    const stack = stackDescriptionOf({ Stacks: [{ StackId: STACK_ID, StackStatus: 'X', Tags: [tower] }] });
    assert.equal(failureCode(stack), 'DescribeStacksOutputMalformed');
  });

  it('refuses a number JSON text overflows to Infinity (1e400)', () => {
    const parsed = JSON.parse('{"MemorySize":1e400}') as object;
    assert.equal(failureCode(functionConfigurationOf(parsed)), 'GetFunctionConfigurationOutputMalformed');
  });

  it('bounds the failure detail of a huge member', () => {
    const read = queueAttributesOf({ Attributes: { RedrivePolicy: ['x'.repeat(100_000)] } });
    assert.ok(!read.ok);
    assert.ok(read.error.detail.length <= 600, String(read.error.detail.length));
  });
});

describe('listAllStackResources', () => {
  function reader(pageSize: number): FakePostDeployReader {
    const account = deployedAccount(runTemplate(), RUN_STACK, STACK_ID, declaredTags());
    account.page_size = pageSize;
    return new FakePostDeployReader(account);
  }

  it('reads every page in order, passing each token on', async () => {
    const paged = reader(3);
    const listed = await listAllStackResources(paged, STACK_ID);
    assert.ok(listed.ok);
    assert.equal(listed.value.length, 16);
    assert.deepEqual(
      paged.calls().map((call) => call.args[1]),
      [undefined, pageToken(1), pageToken(2), pageToken(3), pageToken(4), pageToken(5)],
    );
  });

  it('turns a failed page into a stack read reason', async () => {
    const failing = reader(100);
    failing.failWith('listStackResources', { code: 'Throttling', detail: 'Rate exceeded' });
    assert.deepEqual(await listAllStackResources(failing, STACK_ID), {
      ok: false,
      error: stackReadReason('ListStackResources', STACK_ID, { code: 'Throttling', detail: 'Rate exceeded' }),
    });
  });

  it('refuses a repeated token and a listing longer than the page bound', async () => {
    const repeating = new RepeatingTokenReader(['page-1', 'page-1']);
    const repeated = await listAllStackResources(repeating, STACK_ID);
    assert.equal(failureCode(repeated), 'RESOURCE_LISTING_INCOMPLETE');
    assert.match(repeated.ok ? '' : repeated.error.detail, /repeated NextToken "page-1"/);
    const endless = await listAllStackResources(reader(0), STACK_ID);
    assert.equal(failureCode(endless), 'RESOURCE_LISTING_INCOMPLETE');
    assert.match(endless.ok ? '' : endless.error.detail, new RegExp(`more than ${String(MAX_RESOURCE_PAGES)} pages`));
  });

  it('names the stack, the operation and the service error', () => {
    const reason = stackReadReason('DescribeStacks', RUN_STACK, { code: 'Throttling', detail: 'Rate exceeded' });
    assert.deepEqual(reason, {
      code: 'STACK_READ_FAILED',
      subject: 'BR-RUA-040',
      detail: `DescribeStacks of "${RUN_STACK}" failed with Throttling: Rate exceeded; expected the deployed stack's facts`,
    });
  });
});

// A reader whose ListStackResources hands out the scripted tokens, the last one forever.
class RepeatingTokenReader extends FakePostDeployReader {
  readonly #tokens: string[];

  constructor(tokens: readonly string[]) {
    super(deployedAccount(runTemplate(), RUN_STACK, STACK_ID, declaredTags()));
    this.#tokens = [...tokens];
  }

  override listStackResources(): ReturnType<FakePostDeployReader['listStackResources']> {
    const token = this.#tokens.length > 1 ? this.#tokens.shift() : this.#tokens[0];
    return Promise.resolve({
      ok: true,
      value: { resources: [], ...(token === undefined ? {} : { next_token: token }) },
    });
  }
}
