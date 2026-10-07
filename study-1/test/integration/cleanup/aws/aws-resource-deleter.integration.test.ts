// AwsResourceDeleter over the real clients (BR-RUA-048 step 9, AC-RUA-011): each remaining owned
// resource is deleted by the one request its type takes, in the form that request names it; a
// resource the service no longer knows is already absent; a conflict (a role that still has
// policies) or any other failure is a failed deletion; a durable execution that ended before its
// stop is already absent; a type with no direct delete sends nothing.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AwsResourceDeleter } from '../../../../src/cleanup/aws/aws-resource-deleter.ts';
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
} from '../../../../src/cleanup/resource-types.ts';
import { refuse, reply, ScriptedCleanupEndpoint } from '../../../support/cleanup/aws/scripted-cleanup-endpoint.ts';
import { discovered, NAMES, STACK_ID } from '../../../support/cleanup/cleanup-fixtures.ts';

const FUNCTION_ARN = `arn:aws:lambda:us-east-1:123456789012:function:${NAMES.durableFunction}`;
const DLQ_NAME = NAMES.durableDlqUrl.slice(NAMES.durableDlqUrl.lastIndexOf('/') + 1);

describe('AwsResourceDeleter', () => {
  it('sends the one delete each type takes', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    for (const operation of [
      'lambda:DeleteFunction',
      'lambda:DeleteAlias',
      'lambda:DeleteEventSourceMapping',
      'lambda:StopDurableExecution',
      'sqs:DeleteQueue',
      'dynamodb:DeleteTable',
      'logs:DeleteLogGroup',
      'iam:DeleteRole',
    ]) {
      endpoint.answer(operation, reply(operation.startsWith('iam') ? '' : {}));
    }
    const deleter = new AwsResourceDeleter(endpoint.clients);
    const execution = `${FUNCTION_ARN}:3/durable-execution/e/1`;
    const resources = [
      discovered(FUNCTION_RESOURCE_TYPE, NAMES.durableFunction, 'functions'),
      discovered(FUNCTION_VERSION_RESOURCE_TYPE, `${FUNCTION_ARN}:3`, 'functions'),
      discovered(FUNCTION_ALIAS_RESOURCE_TYPE, `${FUNCTION_ARN}:live`, 'functions'),
      discovered(EVENT_SOURCE_MAPPING_RESOURCE_TYPE, NAMES.sourceMapping, 'event_source_mappings'),
      discovered(DURABLE_EXECUTION_RESOURCE_TYPE, execution, 'durable_executions'),
      discovered(QUEUE_RESOURCE_TYPE, `arn:aws:sqs:us-east-1:123456789012:${DLQ_NAME}`, 'tag_index'),
      discovered(TABLE_RESOURCE_TYPE, NAMES.controlTable, 'tables'),
      discovered(LOG_GROUP_RESOURCE_TYPE, NAMES.providerLogGroup, 'log_groups'),
      discovered(ROLE_RESOURCE_TYPE, NAMES.providerRole, 'roles'),
    ];
    for (const resource of resources) {
      assert.deepEqual(await deleter.delete(resource), { kind: 'deleted' }, resource.resource_type);
    }
    assert.deepEqual(
      endpoint.calls().map((call) => [call.operation, call.input]),
      [
        ['DeleteFunction', { FunctionName: NAMES.durableFunction }],
        ['DeleteFunction', { FunctionName: NAMES.durableFunction, Qualifier: '3' }],
        ['DeleteAlias', { FunctionName: NAMES.durableFunction, Name: 'live' }],
        ['DeleteEventSourceMapping', { UUID: NAMES.sourceMapping }],
        ['StopDurableExecution', { DurableExecutionArn: execution }],
        ['DeleteQueue', { QueueUrl: NAMES.durableDlqUrl }],
        ['DeleteTable', { TableName: NAMES.controlTable }],
        ['DeleteLogGroup', { logGroupName: NAMES.providerLogGroup }],
        ['DeleteRole', { Action: 'DeleteRole', Version: '2010-05-08', RoleName: NAMES.providerRole }],
      ],
    );
    assert.ok(endpoint.calls().every((call) => call.region === 'us-east-1' || call.service === 'iam'));
  });

  it('reads a resource the service no longer knows as already absent', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.answer('sqs:DeleteQueue', refuse('QueueDoesNotExist'));
    endpoint.answer('iam:DeleteRole', refuse('NoSuchEntity', 'no role', 404));
    endpoint.answer('dynamodb:DeleteTable', refuse('ResourceNotFoundException'));
    const deleter = new AwsResourceDeleter(endpoint.clients);
    assert.deepEqual(await deleter.delete(discovered(QUEUE_RESOURCE_TYPE, NAMES.durableDlqUrl, 'queues')), {
      kind: 'already_absent',
    });
    assert.deepEqual(await deleter.delete(discovered(ROLE_RESOURCE_TYPE, NAMES.providerRole, 'roles')), {
      kind: 'already_absent',
    });
    assert.deepEqual(await deleter.delete(discovered(TABLE_RESOURCE_TYPE, NAMES.controlTable, 'tables')), {
      kind: 'already_absent',
    });
  });

  it('reports a role that still has policies, and any other refusal, as failed', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.answer(
      'iam:DeleteRole',
      refuse('DeleteConflict', 'Cannot delete entity, must delete policies first.', 409),
    );
    endpoint.answer('logs:DeleteLogGroup', refuse('OperationAbortedException', 'busy'));
    const deleter = new AwsResourceDeleter(endpoint.clients);
    assert.deepEqual(await deleter.delete(discovered(ROLE_RESOURCE_TYPE, NAMES.providerRole, 'roles')), {
      kind: 'failed',
      reason: {
        code: 'DELETE_CONFLICT_EXCEPTION',
        subject: NAMES.providerRole,
        detail:
          'DeleteConflictException: Cannot delete entity, must delete policies first.; expected the resource to be deleted',
      },
    });
    const logGroup = await deleter.delete(discovered(LOG_GROUP_RESOURCE_TYPE, NAMES.providerLogGroup, 'log_groups'));
    assert.equal(logGroup.kind === 'failed' && logGroup.reason.code, 'OPERATION_ABORTED_EXCEPTION');
  });

  it('stops a durable execution as step 5 does: one that ended since it was seen is already absent', async () => {
    const execution = `${FUNCTION_ARN}:3/durable-execution/e/1`;
    const resource = discovered(DURABLE_EXECUTION_RESOURCE_TYPE, execution, 'durable_executions');
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.answer('lambda:StopDurableExecution', refuse('InvalidParameterValueException', 'not running'));
    endpoint.answer(
      'lambda:GetDurableExecution',
      reply({ DurableExecutionArn: execution, Status: 'SUCCEEDED' }),
      reply({ DurableExecutionArn: execution, Status: 'RUNNING' }),
    );
    const deleter = new AwsResourceDeleter(endpoint.clients);
    assert.deepEqual(await deleter.delete(resource), { kind: 'already_absent' });
    const stillRunning = await deleter.delete(resource);
    assert.equal(stillRunning.kind === 'failed' && stillRunning.reason.code, 'INVALID_PARAMETER_VALUE_EXCEPTION');
    endpoint.answer('lambda:StopDurableExecution', refuse('ResourceNotFoundException', 'gone', 404));
    assert.deepEqual(await deleter.delete(resource), { kind: 'already_absent' });
    assert.deepEqual(
      endpoint.calls().map((call) => call.operation),
      [
        'StopDurableExecution',
        'GetDurableExecution',
        'StopDurableExecution',
        'GetDurableExecution',
        'StopDurableExecution',
      ],
    );
  });

  it('sends nothing for a type with no direct delete', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    const deleter = new AwsResourceDeleter(endpoint.clients);
    for (const resource of [
      discovered(STACK_RESOURCE_TYPE, STACK_ID, 'tag_index'),
      discovered('AWS::IAM::Policy', 'suc1-aaaaaaaa-policy', 'stack_resources'),
    ]) {
      const deletion = await deleter.delete(resource);
      assert.equal(deletion.kind === 'failed' && deletion.reason.code, 'DIRECT_DELETION_UNSUPPORTED');
    }
    assert.deepEqual(endpoint.calls(), []);
  });
});
