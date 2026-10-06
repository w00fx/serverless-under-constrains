// One canonical name per resource across surfaces (BR-RUA-050 membership, design §9.7): a queue
// URL and a stack ARN reduce to their names; every other identifier is its own name.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalResourceName, resourceKey } from '../../../src/cleanup/resource-names.ts';
import { QUEUE_RESOURCE_TYPE, STACK_RESOURCE_TYPE, TABLE_RESOURCE_TYPE } from '../../../src/cleanup/resource-types.ts';

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

describe('resourceKey', () => {
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
