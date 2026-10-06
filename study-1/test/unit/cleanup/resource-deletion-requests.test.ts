// The delete request of each remaining owned resource (BR-RUA-048 step 9): the identifier a
// surface reported is read into the form its delete takes, and a type with no direct delete (a
// stack, an inline policy, an unrecognized tag-index entry) is refused with a reason.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deletionPlanOf } from '../../../src/cleanup/resource-deletion-requests.ts';
import {
  DURABLE_EXECUTION_RESOURCE_TYPE,
  EVENT_SOURCE_MAPPING_RESOURCE_TYPE,
  FUNCTION_ALIAS_RESOURCE_TYPE,
  FUNCTION_RESOURCE_TYPE,
  FUNCTION_VERSION_RESOURCE_TYPE,
  LOG_GROUP_RESOURCE_TYPE,
  QUEUE_RESOURCE_TYPE,
  ROLE_RESOURCE_TYPE,
  STACK_RESOURCE_TYPE,
  TABLE_RESOURCE_TYPE,
} from '../../../src/cleanup/resource-types.ts';
import { UNRECOGNIZED_TAGGED_RESOURCE_TYPE } from '../../../src/cleanup/surface-readings-services.ts';
import { discovered, NAMES, STACK_ID } from '../../support/cleanup/cleanup-fixtures.ts';

const ACCOUNT = '123456789012';
const FUNCTION_ARN = `arn:aws:lambda:us-east-1:${ACCOUNT}:function:${NAMES.durableFunction}`;

function requestOf(resourceType: string, identifier: string): unknown {
  const plan = deletionPlanOf(discovered(resourceType, identifier, 'tag_index'));
  return plan.kind === 'request' ? plan.request : plan.reason.code;
}

describe('deletionPlanOf', () => {
  it('deletes a function, mapping, table and log group by name from a physical id or an ARN', () => {
    assert.deepEqual(requestOf(FUNCTION_RESOURCE_TYPE, NAMES.durableFunction), {
      operation: 'DeleteFunction',
      function_name: NAMES.durableFunction,
    });
    assert.deepEqual(requestOf(FUNCTION_RESOURCE_TYPE, FUNCTION_ARN), {
      operation: 'DeleteFunction',
      function_name: NAMES.durableFunction,
    });
    assert.deepEqual(
      requestOf(EVENT_SOURCE_MAPPING_RESOURCE_TYPE, `arn:aws:lambda:us-east-1:${ACCOUNT}:event-source-mapping:u-1`),
      { operation: 'DeleteEventSourceMapping', mapping_id: 'u-1' },
    );
    assert.deepEqual(requestOf(EVENT_SOURCE_MAPPING_RESOURCE_TYPE, 'u-1'), {
      operation: 'DeleteEventSourceMapping',
      mapping_id: 'u-1',
    });
    assert.deepEqual(
      requestOf(TABLE_RESOURCE_TYPE, `arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/${NAMES.controlTable}`),
      {
        operation: 'DeleteTable',
        table_name: NAMES.controlTable,
      },
    );
    assert.deepEqual(
      requestOf(LOG_GROUP_RESOURCE_TYPE, `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:${NAMES.providerLogGroup}:*`),
      { operation: 'DeleteLogGroup', log_group_name: NAMES.providerLogGroup },
    );
  });

  it('deletes a version through DeleteFunction with its qualifier and an alias through DeleteAlias', () => {
    assert.deepEqual(requestOf(FUNCTION_VERSION_RESOURCE_TYPE, `${FUNCTION_ARN}:3`), {
      operation: 'DeleteFunction',
      function_name: NAMES.durableFunction,
      qualifier: '3',
    });
    assert.deepEqual(requestOf(FUNCTION_ALIAS_RESOURCE_TYPE, `${FUNCTION_ARN}:live`), {
      operation: 'DeleteAlias',
      function_name: NAMES.durableFunction,
      alias_name: 'live',
    });
  });

  it('deletes a queue by its URL, reading a tag-index ARN into the URL', () => {
    assert.deepEqual(requestOf(QUEUE_RESOURCE_TYPE, NAMES.durableDlqUrl), {
      operation: 'DeleteQueue',
      queue_url: NAMES.durableDlqUrl,
    });
    const name = NAMES.durableDlqUrl.slice(NAMES.durableDlqUrl.lastIndexOf('/') + 1);
    assert.deepEqual(requestOf(QUEUE_RESOURCE_TYPE, `arn:aws:sqs:us-east-1:${ACCOUNT}:${name}`), {
      operation: 'DeleteQueue',
      queue_url: NAMES.durableDlqUrl,
    });
  });

  it('deletes a role by name from its name or ARN and stops a durable execution', () => {
    assert.deepEqual(requestOf(ROLE_RESOURCE_TYPE, NAMES.providerRole), {
      operation: 'DeleteRole',
      role_name: NAMES.providerRole,
    });
    assert.deepEqual(requestOf(ROLE_RESOURCE_TYPE, `arn:aws:iam::${ACCOUNT}:role/${NAMES.providerRole}`), {
      operation: 'DeleteRole',
      role_name: NAMES.providerRole,
    });
    const execution = `${FUNCTION_ARN}:3/durable-execution/e/1`;
    assert.deepEqual(requestOf(DURABLE_EXECUTION_RESOURCE_TYPE, execution), {
      operation: 'StopDurableExecution',
      execution_arn: execution,
    });
  });

  it('refuses a type with no direct delete, and an identifier its delete cannot take', () => {
    for (const [type, identifier] of [
      [STACK_RESOURCE_TYPE, STACK_ID],
      ['AWS::IAM::Policy', 'suc1-aaaaaaaa-policy'],
      [UNRECOGNIZED_TAGGED_RESOURCE_TYPE, 'arn:aws:s3:::bucket'],
      ['constructor', 'x'],
      [FUNCTION_VERSION_RESOURCE_TYPE, NAMES.durableFunction],
      [FUNCTION_ALIAS_RESOURCE_TYPE, FUNCTION_ARN],
      [QUEUE_RESOURCE_TYPE, 'suc1-aaaaaaaa-durable-dlq.fifo'],
    ] as const) {
      assert.equal(requestOf(type, identifier), 'DIRECT_DELETION_UNSUPPORTED', `${type} ${identifier}`);
    }
    const plan = deletionPlanOf(discovered(STACK_RESOURCE_TYPE, STACK_ID, 'stack'));
    assert.deepEqual(plan, {
      kind: 'unsupported',
      reason: {
        code: 'DIRECT_DELETION_UNSUPPORTED',
        subject: STACK_ID,
        detail: `${STACK_RESOURCE_TYPE} named ${JSON.stringify(STACK_ID)} has no direct delete; expected a function, version, alias, event-source mapping, queue, table, log group, role or durable execution in the form its delete takes`,
      },
    });
  });
});
