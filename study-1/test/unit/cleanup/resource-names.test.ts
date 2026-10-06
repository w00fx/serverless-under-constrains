// One canonical name per resource across surfaces (BR-RUA-050 membership, design §9.7): a queue
// URL and a stack ARN reduce to their names, and so do the tag-index ARNs (design §9.14) of
// queues, functions, event-source mappings, tables and log groups; every other identifier is its
// own name.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalResourceName, resourceKey } from '../../../src/cleanup/resource-names.ts';
import {
  EVENT_SOURCE_MAPPING_RESOURCE_TYPE,
  FUNCTION_RESOURCE_TYPE,
  FUNCTION_VERSION_RESOURCE_TYPE,
  LOG_GROUP_RESOURCE_TYPE,
  QUEUE_RESOURCE_TYPE,
  ROLE_RESOURCE_TYPE,
  STACK_RESOURCE_TYPE,
  TABLE_RESOURCE_TYPE,
} from '../../../src/cleanup/resource-types.ts';

const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/suc1-aaaaaaaa-durable-dlq.fifo';
const STACK_ARN = 'arn:aws:cloudformation:us-east-1:123456789012:stack/SucRua-run-aaaaaaaa/0f0e0d0c-1111';

describe('canonicalResourceName', () => {
  it('reduces a queue URL to the queue name', () => {
    assert.equal(canonicalResourceName(QUEUE_RESOURCE_TYPE, QUEUE_URL), 'suc1-aaaaaaaa-durable-dlq.fifo');
  });

  it('keeps a queue identifier that is not a URL', () => {
    assert.equal(
      canonicalResourceName(QUEUE_RESOURCE_TYPE, 'suc1-aaaaaaaa-durable-dlq.fifo'),
      'suc1-aaaaaaaa-durable-dlq.fifo',
    );
    assert.equal(canonicalResourceName(QUEUE_RESOURCE_TYPE, `${QUEUE_URL}/extra`), `${QUEUE_URL}/extra`);
  });

  it('reduces a stack ARN to the stack name and keeps a bare stack name', () => {
    assert.equal(canonicalResourceName(STACK_RESOURCE_TYPE, STACK_ARN), 'SucRua-run-aaaaaaaa');
    assert.equal(canonicalResourceName(STACK_RESOURCE_TYPE, 'SucRua-run-aaaaaaaa'), 'SucRua-run-aaaaaaaa');
  });

  it('keeps the identifier of other types, even when it looks like a URL', () => {
    assert.equal(canonicalResourceName(TABLE_RESOURCE_TYPE, QUEUE_URL), QUEUE_URL);
  });
});

const REGION_ACCOUNT = 'us-east-1:123456789012';
const QUEUE_ARN = `arn:aws:sqs:${REGION_ACCOUNT}:suc1-aaaaaaaa-durable-dlq.fifo`;
const FUNCTION_ARN = `arn:aws:lambda:${REGION_ACCOUNT}:function:suc1-aaaaaaaa-refund-provider`;
const MAPPING_ARN = `arn:aws:lambda:${REGION_ACCOUNT}:event-source-mapping:5e5e5e5e-0000-4000-8000-000000000001`;
const TABLE_ARN = `arn:aws:dynamodb:${REGION_ACCOUNT}:table/suc1-aaaaaaaa-control`;
const LOG_GROUP_ARN = `arn:aws:logs:${REGION_ACCOUNT}:log-group:/suc/study-1/aaaaaaaa/refund-provider`;

describe('canonicalResourceName of tag-index ARNs', () => {
  it('reduces each tag-discoverable ARN to the physical id CloudFormation records', () => {
    const reduced: readonly (readonly [string, string, string])[] = [
      [QUEUE_RESOURCE_TYPE, QUEUE_ARN, 'suc1-aaaaaaaa-durable-dlq.fifo'],
      [FUNCTION_RESOURCE_TYPE, FUNCTION_ARN, 'suc1-aaaaaaaa-refund-provider'],
      [EVENT_SOURCE_MAPPING_RESOURCE_TYPE, MAPPING_ARN, '5e5e5e5e-0000-4000-8000-000000000001'],
      [TABLE_RESOURCE_TYPE, TABLE_ARN, 'suc1-aaaaaaaa-control'],
      [LOG_GROUP_RESOURCE_TYPE, LOG_GROUP_ARN, '/suc/study-1/aaaaaaaa/refund-provider'],
      [LOG_GROUP_RESOURCE_TYPE, `${LOG_GROUP_ARN}:*`, '/suc/study-1/aaaaaaaa/refund-provider'],
      [TABLE_RESOURCE_TYPE, `arn:aws-us-gov:dynamodb::123456789012:table/t`, 't'],
    ];
    for (const [type, arn, name] of reduced) {
      assert.equal(canonicalResourceName(type, arn), name, arn);
    }
  });

  it('keeps an identifier whose ARN does not have the exact shape of its type', () => {
    const kept: readonly (readonly [string, string])[] = [
      [FUNCTION_RESOURCE_TYPE, `${FUNCTION_ARN}:live`],
      [FUNCTION_RESOURCE_TYPE, MAPPING_ARN],
      [FUNCTION_RESOURCE_TYPE, `x${FUNCTION_ARN}`],
      [FUNCTION_RESOURCE_TYPE, `arn::lambda:${REGION_ACCOUNT}:function:f`],
      [FUNCTION_RESOURCE_TYPE, `arn:aws:lambda:us-east-1:1:2:function:f`],
      [FUNCTION_RESOURCE_TYPE, `arn:aws:lambda:${REGION_ACCOUNT}:function:`],
      [EVENT_SOURCE_MAPPING_RESOURCE_TYPE, FUNCTION_ARN],
      [EVENT_SOURCE_MAPPING_RESOURCE_TYPE, `${MAPPING_ARN}:extra`],
      [QUEUE_RESOURCE_TYPE, `${QUEUE_ARN}/x`],
      [QUEUE_RESOURCE_TYPE, `arn:aws:sns:${REGION_ACCOUNT}:topic`],
      [QUEUE_RESOURCE_TYPE, `arn:aws:sqs:${REGION_ACCOUNT}:`],
      [TABLE_RESOURCE_TYPE, `${TABLE_ARN}/stream/2026-10-05T12:00:00.000`],
      [TABLE_RESOURCE_TYPE, `arn:aws:dynamodb:${REGION_ACCOUNT}:table/`],
      [LOG_GROUP_RESOURCE_TYPE, `${LOG_GROUP_ARN}:log-stream:s`],
      [LOG_GROUP_RESOURCE_TYPE, `${LOG_GROUP_ARN}:`],
      [LOG_GROUP_RESOURCE_TYPE, `arn:aws:logs:${REGION_ACCOUNT}:log-group:`],
      [STACK_RESOURCE_TYPE, TABLE_ARN],
    ];
    for (const [type, identifier] of kept) {
      assert.equal(canonicalResourceName(type, identifier), identifier, identifier);
    }
  });

  it('reduces no ARN of a type outside the tag index, nor of an inherited-member type name', () => {
    for (const type of [ROLE_RESOURCE_TYPE, FUNCTION_VERSION_RESOURCE_TYPE, 'constructor', '__proto__', 'toString']) {
      assert.equal(canonicalResourceName(type, FUNCTION_ARN), FUNCTION_ARN, type);
      assert.equal(canonicalResourceName(type, QUEUE_URL), QUEUE_URL, type);
    }
  });
});

describe('resourceKey', () => {
  it('meets the manifest physical id from the tag-index ARN of each type', () => {
    const forms: readonly (readonly [string, string, string])[] = [
      [QUEUE_RESOURCE_TYPE, QUEUE_ARN, QUEUE_URL],
      [FUNCTION_RESOURCE_TYPE, FUNCTION_ARN, 'suc1-aaaaaaaa-refund-provider'],
      [EVENT_SOURCE_MAPPING_RESOURCE_TYPE, MAPPING_ARN, '5e5e5e5e-0000-4000-8000-000000000001'],
      [TABLE_RESOURCE_TYPE, TABLE_ARN, 'suc1-aaaaaaaa-control'],
      [LOG_GROUP_RESOURCE_TYPE, LOG_GROUP_ARN, '/suc/study-1/aaaaaaaa/refund-provider'],
    ];
    for (const [type, arn, physicalId] of forms) {
      assert.equal(
        resourceKey({ resource_type: type, identifier: arn }),
        resourceKey({ resource_type: type, identifier: physicalId }),
      );
    }
  });

  it('names a queue the same way by URL and by name, separately per type', () => {
    assert.equal(
      resourceKey({ resource_type: QUEUE_RESOURCE_TYPE, identifier: QUEUE_URL }),
      resourceKey({ resource_type: QUEUE_RESOURCE_TYPE, identifier: 'suc1-aaaaaaaa-durable-dlq.fifo' }),
    );
    assert.notEqual(
      resourceKey({ resource_type: QUEUE_RESOURCE_TYPE, identifier: 'x' }),
      resourceKey({ resource_type: TABLE_RESOURCE_TYPE, identifier: 'x' }),
    );
    assert.equal(
      resourceKey({ resource_type: STACK_RESOURCE_TYPE, identifier: STACK_ARN }),
      `${STACK_RESOURCE_TYPE}|SucRua-run-aaaaaaaa`,
    );
  });
});
