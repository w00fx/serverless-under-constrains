// Conformance of ScriptedRunAccount with the AWS behavior cleanup's adapters depend on, through
// the real clients: a disabled mapping reads `Disabled`; a stack deletion with a durable execution
// still running fails (`DELETE_FAILED`, RK-10) and, once it is stopped, removes the stack and its
// members, the deleted stack then reading DELETE_COMPLETE by its unique id and "does not exist"
// by its name; the DLQ hides what it returns until a delete or release by receipt handle.
//
// Sources (RK-17): [R-aws] §6.3, ESM `State` values and "Deleted stacks: you must pass the unique
// stack ID"; the CloudFormation API reference (read 2026-10-06): `DescribeStacks` "If the stack
// doesn't exist, a ValidationError is returned", `ListStackResources` "For deleted stacks ...
// returns resource information for up to 90 days after the stack has been deleted"
// (https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_DescribeStacks.html,
// https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_ListStackResources.html);
// [R-durable] §3.2 and §8 R8, "Deletion for durable functions will wait for all running
// executions to complete. CloudFormation will wait up to 1 hour" (the wait is not modelled: the
// deletion fails at once); [R-aws] §3, a received message stays hidden until deleted or visible.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DeleteStackCommand, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  GetEventSourceMappingCommand,
  GetFunctionCommand,
  StopDurableExecutionCommand,
  UpdateEventSourceMappingCommand,
} from '@aws-sdk/client-lambda';
import type { Message } from '@aws-sdk/client-sqs';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';

import { settleCleanupCall } from '../../../../../src/cleanup/sdk-call-outcomes.ts';
import { LIVE } from '../../../../support/cleanup/aws/live-run-script.ts';
import { ScriptedRunAccount } from '../../../../support/cleanup/aws/scripted-run-account.ts';
import { NAMES, STACK_ID, STACK_NAME } from '../../../../support/cleanup/cleanup-fixtures.ts';

describe('ScriptedRunAccount', () => {
  it('disables the source mapping', async () => {
    const { lambda } = new ScriptedRunAccount().endpoint.clients;
    const read = (): Promise<string | undefined> =>
      lambda.send(new GetEventSourceMappingCommand({ UUID: NAMES.sourceMapping })).then((mapping) => mapping.State);
    assert.equal(await read(), 'Enabled');
    await lambda.send(new UpdateEventSourceMappingCommand({ UUID: NAMES.sourceMapping, Enabled: false }));
    assert.equal(await read(), 'Disabled');
  });

  it('fails a stack deletion while a durable execution runs, and deletes the stack once it is stopped', async () => {
    const account = new ScriptedRunAccount();
    const { cloudformation, lambda } = account.endpoint.clients;
    const status = (): Promise<string | undefined> =>
      cloudformation
        .send(new DescribeStacksCommand({ StackName: STACK_ID }))
        .then((out) => out.Stacks?.[0]?.StackStatus);
    await cloudformation.send(new DeleteStackCommand({ StackName: STACK_ID }));
    assert.equal(await status(), 'DELETE_FAILED');
    assert.equal(account.stackDeleted(), false);
    await lambda.send(new StopDurableExecutionCommand({ DurableExecutionArn: LIVE.executionArn }));
    await cloudformation.send(new DeleteStackCommand({ StackName: STACK_ID }));
    assert.equal(account.stackDeleted(), true);
    assert.equal(await status(), 'DELETE_COMPLETE', 'a deleted stack is still described by its unique id');
    const byName = await settleCleanupCall(() =>
      cloudformation.send(new DescribeStacksCommand({ StackName: STACK_NAME })),
    );
    assert.equal(!byName.ok && byName.error.message, `Stack with id ${STACK_NAME} does not exist`);
    const fn = await settleCleanupCall(() =>
      lambda.send(new GetFunctionCommand({ FunctionName: NAMES.providerFunction })),
    );
    assert.equal(!fn.ok && fn.error.name, 'ResourceNotFoundException');
  });

  it('hides received DLQ messages until deleted or released', async () => {
    const account = new ScriptedRunAccount();
    account.enqueueDlqMessage('m-1');
    account.enqueueDlqMessage('m-2');
    const { sqs } = account.endpoint.clients;
    const receive = (): Promise<readonly Message[]> =>
      sqs.send(new ReceiveMessageCommand({ QueueUrl: NAMES.durableDlqUrl })).then((out) => out.Messages ?? []);
    const [first, second] = await receive();
    assert.deepEqual(await receive(), []);
    await sqs.send(new DeleteMessageCommand({ QueueUrl: NAMES.durableDlqUrl, ReceiptHandle: first?.ReceiptHandle }));
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: NAMES.durableDlqUrl,
        ReceiptHandle: second?.ReceiptHandle,
        VisibilityTimeout: 0,
      }),
    );
    assert.deepEqual(account.dlqMessageIds(), ['m-2']);
    assert.deepEqual(
      (await receive()).map((message) => message.MessageId),
      ['m-2'],
    );
  });
});
