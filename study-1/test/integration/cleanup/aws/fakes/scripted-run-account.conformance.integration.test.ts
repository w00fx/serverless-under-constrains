// Conformance of ScriptedRunAccount with the AWS behavior cleanup's adapters depend on, through
// the real clients: a disabled mapping reads `Disabled`; a stack deletion with a durable execution
// still running fails (`DELETE_FAILED`, RK-10) and, once it is stopped, removes the stack and its
// members; the DLQ hides what it returns until a delete or release by receipt handle.

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
import { NAMES, STACK_ID } from '../../../../support/cleanup/cleanup-fixtures.ts';

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
    const describe_ = await settleCleanupCall(() => status());
    assert.equal(!describe_.ok && describe_.error.message, `Stack with id ${STACK_ID} does not exist`);
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
