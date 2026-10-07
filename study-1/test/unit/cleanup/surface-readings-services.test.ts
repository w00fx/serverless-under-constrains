// Readings of Tagging API, CloudFormation, SQS, DynamoDB, CloudWatch Logs and IAM SDK output
// (design §9.14): every resource named by the physical id CloudFormation records (a role by its
// name, a queue by its URL), stack listings without tags, and malformed members refused.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EVENT_SOURCE_MAPPING_RESOURCE_TYPE,
  FUNCTION_ALIAS_RESOURCE_TYPE,
  FUNCTION_RESOURCE_TYPE,
  FUNCTION_VERSION_RESOURCE_TYPE,
  LOG_GROUP_RESOURCE_TYPE,
  QUEUE_RESOURCE_TYPE,
  ROLE_RESOURCE_TYPE,
  STACK_RESOURCE_TYPE,
  TABLE_RESOURCE_TYPE,
  TABLE_STREAM_RESOURCE_TYPE,
} from '../../../src/cleanup/resource-types.ts';
import { MALFORMED_OUTPUT } from '../../../src/cleanup/surface-readings.ts';
import {
  logGroupsPage,
  queueCreatedAt,
  queueUrlOfArn,
  queueUrlOfIdentifier,
  queueUrlReading,
  queueUrlsPage,
  receivedDlqMessages,
  resourceTypeOfArn,
  roleNameOfArn,
  roleReading,
  roleTagsPage,
  skippedStackResourcesPage,
  STACK_LISTING_TAGS,
  stackReading,
  stackResourcesPage,
  stackSighting,
  tableReading,
  tableTagsPage,
  tagIndexPage,
  UNRECOGNIZED_TAGGED_RESOURCE_TYPE,
} from '../../../src/cleanup/surface-readings-services.ts';
import { ok } from '../../../src/record-contract/primitives.ts';
import { NAMES, STACK_ID } from '../../support/cleanup/cleanup-fixtures.ts';

const ACCOUNT = '123456789012';
const RUN_TAG = { Key: 'suc:run_id', Value: 'r' };
const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/service/suc1-aaaaaaaa-provider`;
const QUEUE_ARN = `arn:aws:sqs:us-east-1:${ACCOUNT}:suc1-aaaaaaaa-durable-dlq.fifo`;
const QUEUE_URL = `https://sqs.us-east-1.amazonaws.com/${ACCOUNT}/suc1-aaaaaaaa-durable-dlq.fifo`;
const TABLE_ARN = `arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/${NAMES.controlTable}`;
const LOG_GROUP_ARN = `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:${NAMES.providerLogGroup}`;
const FUNCTION_ARN = `arn:aws:lambda:us-east-1:${ACCOUNT}:function:f`;
const CREATED = new Date('2026-10-05T11:30:00.000Z');

function malformed(
  subject: string,
  detail: string,
): { ok: false; error: { code: string; subject: string; detail: string } } {
  return { ok: false, error: { code: MALFORMED_OUTPUT, subject, detail } };
}

describe('tagIndexPage', () => {
  it('lists every ARN with its tags under its type; a role by its name', () => {
    const output = {
      ResourceTagMappingList: [
        { ResourceARN: TABLE_ARN, Tags: [RUN_TAG] },
        { ResourceARN: ROLE_ARN, Tags: [] },
      ],
      PaginationToken: 't',
    };
    assert.deepEqual(
      tagIndexPage(output),
      ok({
        items: [
          {
            resource_type: TABLE_RESOURCE_TYPE,
            identifier: TABLE_ARN,
            surface: 'tag_index',
            tags: { kind: 'tagged', tags: [{ key: 'suc:run_id', value: 'r' }] },
          },
          {
            resource_type: ROLE_RESOURCE_TYPE,
            identifier: 'suc1-aaaaaaaa-provider',
            surface: 'tag_index',
            tags: { kind: 'tagged', tags: [] },
          },
        ],
        cursor: 't',
      }),
    );
    assert.deepEqual(tagIndexPage({ PaginationToken: '' }), ok({ items: [] }));
  });

  it('refuses an entry without an ARN or with malformed tags', () => {
    const at = 'GetResources.ResourceTagMappingList[0]';
    assert.deepEqual(
      tagIndexPage({ ResourceTagMappingList: [{ Tags: [] }] }),
      malformed(at, 'ResourceARN is absent; expected a non-empty string'),
    );
    assert.deepEqual(
      tagIndexPage({ ResourceTagMappingList: [{ ResourceARN: TABLE_ARN, Tags: 'x' }] }),
      malformed(at, 'Tags is "x"; expected a list'),
    );
  });
});

describe('resourceTypeOfArn', () => {
  it('names the type of every ARN form the run creates', () => {
    const cases: readonly (readonly [string, string])[] = [
      [STACK_ID, STACK_RESOURCE_TYPE],
      [QUEUE_ARN, QUEUE_RESOURCE_TYPE],
      [FUNCTION_ARN, FUNCTION_RESOURCE_TYPE],
      [`arn:aws:lambda:us-east-1:${ACCOUNT}:event-source-mapping:u`, EVENT_SOURCE_MAPPING_RESOURCE_TYPE],
      [TABLE_ARN, TABLE_RESOURCE_TYPE],
      [`${LOG_GROUP_ARN}:*`, LOG_GROUP_RESOURCE_TYPE],
      [`${FUNCTION_ARN}:3`, FUNCTION_VERSION_RESOURCE_TYPE],
      [`${FUNCTION_ARN}:$LATEST`, FUNCTION_VERSION_RESOURCE_TYPE],
      [`${FUNCTION_ARN}:live`, FUNCTION_ALIAS_RESOURCE_TYPE],
      [`${FUNCTION_ARN}:3a`, FUNCTION_ALIAS_RESOURCE_TYPE],
      [ROLE_ARN, ROLE_RESOURCE_TYPE],
      [`arn:aws:s3:::bucket`, UNRECOGNIZED_TAGGED_RESOURCE_TYPE],
      // A-16: the tag index lists a table's stream with the table's tags (first real probe).
      [`${TABLE_ARN}/stream/2026-10-07T03:47:38.240`, TABLE_STREAM_RESOURCE_TYPE],
      [`${TABLE_ARN}/stream/a/b`, UNRECOGNIZED_TAGGED_RESOURCE_TYPE],
    ];
    for (const [arn, type] of cases) {
      assert.equal(resourceTypeOfArn(arn), type, arn);
    }
  });

  it('reads the role name of a role ARN, with or without a path', () => {
    assert.equal(roleNameOfArn(ROLE_ARN), 'suc1-aaaaaaaa-provider');
    assert.equal(roleNameOfArn(`arn:aws:iam::${ACCOUNT}:role/r`), 'r');
    assert.equal(roleNameOfArn(`arn:aws:iam::${ACCOUNT}:user/r`), undefined);
  });
});

describe('queue identifiers', () => {
  it('reads the URL of a queue ARN and keeps a URL as is', () => {
    assert.equal(queueUrlOfArn(QUEUE_ARN), QUEUE_URL);
    assert.equal(queueUrlOfArn(QUEUE_URL), undefined);
    assert.equal(queueUrlOfIdentifier(QUEUE_ARN), QUEUE_URL);
    assert.equal(queueUrlOfIdentifier(QUEUE_URL), QUEUE_URL);
    assert.equal(queueUrlOfIdentifier('suc1-aaaaaaaa-durable-dlq.fifo'), undefined);
  });

  it('reads GetQueueUrl, ListQueues pages and the creation time in epoch seconds', () => {
    assert.deepEqual(queueUrlReading({ QueueUrl: QUEUE_URL }), ok(QUEUE_URL));
    assert.deepEqual(
      queueUrlsPage({ QueueUrls: [QUEUE_URL], NextToken: 'n' }),
      ok({ items: [QUEUE_URL], cursor: 'n' }),
    );
    assert.deepEqual(queueUrlsPage({}), ok({ items: [] }));
    assert.deepEqual(
      queueUrlsPage({ QueueUrls: [''] }),
      malformed('ListQueues.QueueUrls[0]', 'QueueUrl is ""; expected a queue URL'),
    );
    assert.deepEqual(
      queueUrlsPage({ QueueUrls: [7] }),
      malformed('ListQueues.QueueUrls[0]', 'QueueUrl is 7; expected a queue URL'),
    );
    assert.deepEqual(queueCreatedAt({ Attributes: { CreatedTimestamp: '0' } }), ok('1970-01-01T00:00:00.000Z'));
    assert.deepEqual(
      queueCreatedAt({ Attributes: { CreatedTimestamp: '1791201600' } }),
      ok('2026-10-05T12:00:00.000Z'),
    );
    assert.deepEqual(queueCreatedAt({ Attributes: {} }), ok(undefined));
    assert.deepEqual(queueCreatedAt({}), ok(undefined));
  });

  it('refuses a creation time that is not epoch seconds in range', () => {
    for (const refused of ['01', '-1', '1.5', '', '9999999999999', 1791201600]) {
      assert.deepEqual(
        queueCreatedAt({ Attributes: { CreatedTimestamp: refused } }).ok,
        false,
        `${typeof refused} ${String(refused)}`,
      );
    }
    assert.deepEqual(
      queueCreatedAt({ Attributes: { CreatedTimestamp: 'x' } }),
      malformed('GetQueueAttributes.Attributes', 'CreatedTimestamp is "x"; expected epoch seconds as digits'),
    );
  });

  it('reads the received messages of a DLQ receive', () => {
    assert.deepEqual(
      receivedDlqMessages({ Messages: [{ MessageId: 'm1', ReceiptHandle: 'r1', Body: 'b' }] }),
      ok([{ message_id: 'm1', receipt_handle: 'r1' }]),
    );
    assert.deepEqual(receivedDlqMessages({}), ok([]));
    assert.deepEqual(
      receivedDlqMessages({ Messages: [{ ReceiptHandle: 'r1' }] }),
      malformed('ReceiveMessage.Messages[0]', 'MessageId is absent; expected a non-empty string'),
    );
    assert.deepEqual(
      receivedDlqMessages({ Messages: [{ MessageId: 'm1' }] }),
      malformed('ReceiveMessage.Messages[0]', 'ReceiptHandle is absent; expected a non-empty string'),
    );
  });
});

describe('stack readings', () => {
  const stack = { StackId: STACK_ID, StackStatus: 'CREATE_COMPLETE', Tags: [RUN_TAG], CreationTime: CREATED };

  it('reads the one stack DescribeStacks lists, or none', () => {
    assert.deepEqual(
      stackReading({ Stacks: [stack] }),
      ok({
        stack_id: STACK_ID,
        status: 'CREATE_COMPLETE',
        tags: [{ key: 'suc:run_id', value: 'r' }],
        created_at: '2026-10-05T11:30:00.000Z',
      }),
    );
    assert.deepEqual(stackReading({ Stacks: [] }), ok(undefined));
    assert.deepEqual(stackReading({}), ok(undefined));
  });

  it('refuses more than one stack and any malformed member', () => {
    assert.deepEqual(
      stackReading({ Stacks: [stack, stack] }),
      malformed('DescribeStacks', 'Stacks is 2; expected at most the one stack asked for'),
    );
    const at = 'DescribeStacks.Stacks[0]';
    assert.deepEqual(stackReading({ Stacks: [{}] }), malformed(at, 'StackId is absent; expected a non-empty string'));
    assert.deepEqual(
      stackReading({ Stacks: [{ StackId: STACK_ID }] }),
      malformed(at, 'StackStatus is absent; expected a non-empty string'),
    );
    assert.deepEqual(stackReading({ Stacks: [{ ...stack, Tags: 1 }] }), malformed(at, 'Tags is 1; expected a list'));
    assert.deepEqual(
      stackReading({ Stacks: [{ ...stack, CreationTime: 'now' }] }),
      malformed(at, 'CreationTime is "now"; expected a valid instant in years 0000-9999'),
    );
    assert.deepEqual(stackReading({ Stacks: 'x' }), malformed('DescribeStacks', 'Stacks is "x"; expected a list'));
  });

  it('sights a live stack with its tags and no stack once it is DELETE_COMPLETE', () => {
    assert.deepEqual(stackSighting({ stack_id: STACK_ID, status: 'DELETE_IN_PROGRESS', tags: [] }), {
      resource_type: STACK_RESOURCE_TYPE,
      identifier: STACK_ID,
      surface: 'stack',
      tags: { kind: 'tagged', tags: [] },
    });
    const created = '2026-10-05T11:30:00.000Z' as const;
    assert.equal(
      stackSighting({ stack_id: STACK_ID, status: 'CREATE_COMPLETE', tags: [], created_at: created as never })
        ?.created_at,
      created,
    );
    assert.equal(stackSighting({ stack_id: STACK_ID, status: 'DELETE_COMPLETE', tags: [] }), undefined);
    assert.equal(stackSighting(undefined), undefined);
  });

  it('lists what the stack still manages, by physical id, owned through the stack', () => {
    const summaries = [
      { ResourceType: TABLE_RESOURCE_TYPE, PhysicalResourceId: NAMES.controlTable, ResourceStatus: 'CREATE_COMPLETE' },
      { ResourceType: ROLE_RESOURCE_TYPE, PhysicalResourceId: 'gone', ResourceStatus: 'DELETE_COMPLETE' },
      { ResourceType: ROLE_RESOURCE_TYPE, PhysicalResourceId: 'kept', ResourceStatus: 'DELETE_SKIPPED' },
      { ResourceType: QUEUE_RESOURCE_TYPE, ResourceStatus: 'CREATE_FAILED' },
    ];
    assert.deepEqual(
      stackResourcesPage({ StackResourceSummaries: summaries, NextToken: 'n' }, STACK_ID),
      ok({
        items: [
          {
            resource_type: TABLE_RESOURCE_TYPE,
            identifier: NAMES.controlTable,
            surface: 'stack_resources',
            tags: STACK_LISTING_TAGS,
            managed_by_stack_id: STACK_ID,
          },
          {
            resource_type: ROLE_RESOURCE_TYPE,
            identifier: 'kept',
            surface: 'stack_resources',
            tags: STACK_LISTING_TAGS,
            managed_by_stack_id: STACK_ID,
          },
        ],
        cursor: 'n',
      }),
    );
  });

  it('keeps the resources whose deletion the stack skipped', () => {
    const events = [
      { ResourceType: ROLE_RESOURCE_TYPE, PhysicalResourceId: 'kept', ResourceStatus: 'DELETE_SKIPPED' },
      { ResourceType: TABLE_RESOURCE_TYPE, PhysicalResourceId: 't', ResourceStatus: 'DELETE_COMPLETE' },
      { ResourceType: STACK_RESOURCE_TYPE, PhysicalResourceId: '', ResourceStatus: 'DELETE_SKIPPED' },
    ];
    const page = skippedStackResourcesPage({ StackEvents: events }, STACK_ID);
    assert.deepEqual(page.ok && page.value.items.map((item) => item.identifier), ['kept']);
  });

  it('refuses a malformed listing entry', () => {
    const at = 'ListStackResources.StackResourceSummaries[0]';
    assert.deepEqual(
      stackResourcesPage({ StackResourceSummaries: [{}] }, STACK_ID),
      malformed(at, 'ResourceType is absent; expected a non-empty string'),
    );
    assert.deepEqual(
      stackResourcesPage({ StackResourceSummaries: [{ ResourceType: 'T' }] }, STACK_ID),
      malformed(at, 'ResourceStatus is absent; expected a non-empty string'),
    );
    assert.deepEqual(
      stackResourcesPage(
        { StackResourceSummaries: [{ ResourceType: 'T', ResourceStatus: 'S', PhysicalResourceId: 1 }] },
        STACK_ID,
      ),
      malformed(at, 'PhysicalResourceId is 1; expected a non-empty string'),
    );
    assert.deepEqual(
      skippedStackResourcesPage({ StackEvents: 1 }, STACK_ID),
      malformed('DescribeStackEvents', 'StackEvents is 1; expected a list'),
    );
  });
});

describe('table, role and log group readings', () => {
  it('reads a described table and role with name, ARN and creation time', () => {
    const table = { TableName: NAMES.controlTable, TableArn: TABLE_ARN, CreationDateTime: CREATED };
    assert.deepEqual(
      tableReading({ Table: table }),
      ok({ name: NAMES.controlTable, arn: TABLE_ARN, created_at: '2026-10-05T11:30:00.000Z' }),
    );
    assert.deepEqual(roleReading({ Role: { RoleName: 'r', Arn: ROLE_ARN } }), ok({ name: 'r', arn: ROLE_ARN }));
  });

  it('refuses a description without a name, an ARN or a valid creation time', () => {
    assert.deepEqual(
      tableReading({}),
      malformed('DescribeTable.Table', 'TableName is absent; expected a non-empty string'),
    );
    assert.deepEqual(
      roleReading({ Role: { RoleName: 'r' } }),
      malformed('GetRole.Role', 'Arn is absent; expected a non-empty string'),
    );
    assert.deepEqual(
      roleReading({ Role: { RoleName: 'r', Arn: ROLE_ARN, CreateDate: 5 } }),
      malformed('GetRole.Role', 'CreateDate is 5; expected a valid instant in years 0000-9999'),
    );
  });

  it('pages table tags by NextToken and role tags by Marker while truncated', () => {
    assert.deepEqual(
      tableTagsPage({ Tags: [RUN_TAG], NextToken: 'n' }),
      ok({ items: [{ key: 'suc:run_id', value: 'r' }], cursor: 'n' }),
    );
    assert.deepEqual(tableTagsPage({ Tags: 'x' }), malformed('ListTagsOfResource', 'Tags is "x"; expected a list'));
    assert.deepEqual(
      roleTagsPage({ Tags: [RUN_TAG], IsTruncated: true, Marker: 'm' }),
      ok({
        items: [{ key: 'suc:run_id', value: 'r' }],
        cursor: 'm',
      }),
    );
    assert.deepEqual(roleTagsPage({ Tags: [], IsTruncated: false, Marker: 'm' }), ok({ items: [] }));
    assert.deepEqual(roleTagsPage({ Tags: [], IsTruncated: 'true', Marker: 'm' }), ok({ items: [] }));
    assert.deepEqual(
      roleTagsPage({ Tags: [], IsTruncated: true }),
      malformed('ListRoleTags', 'Marker is absent; expected a non-empty string'),
    );
    assert.deepEqual(
      roleTagsPage({ Tags: {} }),
      malformed('ListRoleTags', 'Tags is a value of type object; expected a list'),
    );
  });

  it('reads log groups by name with the ARN their tags are read by', () => {
    const output = {
      logGroups: [
        { logGroupName: 'a', logGroupArn: LOG_GROUP_ARN, arn: `${LOG_GROUP_ARN}:*`, creationTime: 0 },
        { logGroupName: 'b', arn: `${LOG_GROUP_ARN}:*` },
      ],
      nextToken: 'n',
    };
    assert.deepEqual(
      logGroupsPage(output),
      ok({
        items: [
          { name: 'a', arn: LOG_GROUP_ARN, created_at: '1970-01-01T00:00:00.000Z' },
          { name: 'b', arn: LOG_GROUP_ARN },
        ],
        cursor: 'n',
      }),
    );
  });

  it('refuses a log group without a name, an ARN or a valid creation time', () => {
    const at = 'DescribeLogGroups.logGroups[0]';
    assert.deepEqual(
      logGroupsPage({ logGroups: [{}] }),
      malformed(at, 'logGroupName is absent; expected a non-empty string'),
    );
    assert.deepEqual(
      logGroupsPage({ logGroups: [{ logGroupName: 'a' }] }),
      malformed(at, 'arn is absent; expected a non-empty string'),
    );
    assert.deepEqual(
      logGroupsPage({ logGroups: [{ logGroupName: 'a', logGroupArn: 7 }] }),
      malformed(at, 'logGroupArn is 7; expected a non-empty string'),
    );
    assert.deepEqual(
      logGroupsPage({ logGroups: [{ logGroupName: 'a', arn: LOG_GROUP_ARN, creationTime: Number.POSITIVE_INFINITY }] }),
      malformed(at, 'creationTime is Infinity; expected epoch milliseconds in years 0000-9999'),
    );
    assert.deepEqual(
      logGroupsPage({ logGroups: 1 }),
      malformed('DescribeLogGroups', 'logGroups is 1; expected a list'),
    );
  });
});
