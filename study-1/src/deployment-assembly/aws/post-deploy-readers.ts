// AWS binding of the post-deploy reads (design §9.8 D4; BR-RUA-040, BR-RUA-053; addendum §2.4):
// `cloudformation:DescribeStacks` and `ListStackResources`, `lambda:GetFunctionConfiguration`,
// `GetEventSourceMapping` and `GetProvisionedConcurrencyConfig`, `sqs:GetQueueAttributes` and
// `dynamodb:DescribeTable`. Every call is a read; no mutating command is imported here. Thin by
// construction: one request per port call, the raw output handed to the total mappers of
// `post-deploy-reading.ts`. Clients use `maxAttempts: 1` and the study Region, so a retry never
// hides a failure and no other Region is ever read.
// Two service errors are answers, not failed reads: DescribeStacks of a stack that does not exist
// (`ValidationError`), and GetProvisionedConcurrencyConfig of a version or alias that has none
// (`ProvisionedConcurrencyConfigNotFoundException`, the Lambda API reference's documented error).
// UNVERIFIED (cloud phase): both error names and messages on a real account.

import { CloudFormationClient, DescribeStacksCommand, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import type { CloudFormationClientConfig } from '@aws-sdk/client-cloudformation';
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import {
  GetEventSourceMappingCommand,
  GetFunctionConfigurationCommand,
  GetProvisionedConcurrencyConfigCommand,
  LambdaClient,
} from '@aws-sdk/client-lambda';
import type { LambdaClientConfig } from '@aws-sdk/client-lambda';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { SQSClientConfig } from '@aws-sdk/client-sqs';

import { nonEmptyString, ownValue } from '../../evidence-collection/sdk-values.ts';
import { boundedText } from '../../record-contract/json-value.ts';
import { err, ok } from '../../record-contract/primitives.ts';
import type { Result } from '../../record-contract/primitives.ts';
import {
  absentProvisionedConcurrency,
  eventSourceMappingOf,
  functionConfigurationOf,
  isMissingStack,
  PROVISIONED_CONCURRENCY_NOT_FOUND,
  provisionedConcurrencyOf,
  queueAttributesOf,
  stackDescriptionOf,
  stackResourcePageOf,
  tableDescriptionOf,
} from '../post-deploy-reading.ts';
import type {
  AttributeReading,
  PostDeployRead,
  PostDeployReader,
  PostDeployReadFailure,
  StackResourcePage,
} from '../post-deploy-reading.ts';
import type { StackDescription } from '../resource-manifest.ts';

export const POST_DEPLOY_CLIENT_OPTIONS = { region: 'us-east-1', maxAttempts: 1 } as const;
const PINNED_SETTING_NAMES: ReadonlySet<string> = new Set(['region', 'maxAttempts', 'retryStrategy', 'retryMode']);
const MESSAGE_CHARACTERS = 600;

type Pinned = 'region' | 'maxAttempts' | 'retryStrategy' | 'retryMode';

/** Client settings a caller may supply (tests: a scripted `requestHandler` and static credentials). */
export type PostDeployClientSettings = Omit<CloudFormationClientConfig, Pinned> &
  Omit<LambdaClientConfig, Pinned> &
  Omit<SQSClientConfig, Pinned> &
  Omit<DynamoDBClientConfig, Pinned>;

/** The four read-only clients of the post-deploy reads. */
export interface PostDeployClients {
  readonly cloudformation: CloudFormationClient;
  readonly lambda: LambdaClient;
  readonly sqs: SQSClient;
  readonly dynamodb: DynamoDBClient;
}

/**
 * Builds the post-deploy clients; production passes nothing.
 *
 * @example
 * const reader = createPostDeployReader(createPostDeployClients());
 */
export function createPostDeployClients(settings: PostDeployClientSettings = {}): PostDeployClients {
  // A cast can smuggle a pinned key past the type, so pinned keys are dropped at run time too.
  const allowed = Object.fromEntries(Object.entries(settings).filter(([name]) => !PINNED_SETTING_NAMES.has(name)));
  const config = { ...allowed, ...POST_DEPLOY_CLIENT_OPTIONS };
  return {
    cloudformation: new CloudFormationClient(config),
    lambda: new LambdaClient(config),
    sqs: new SQSClient(config),
    dynamodb: new DynamoDBClient(config),
  };
}

/**
 * The post-deploy reader over the four clients: one request per call.
 *
 * @example
 * const described = await createPostDeployReader(clients).describeStack('SucRua-run-3f1c2a9e');
 */
export function createPostDeployReader(clients: PostDeployClients): PostDeployReader {
  return {
    describeStack: async (stackName: string): PostDeployRead<StackDescription | undefined> => {
      const output = await settle(() =>
        clients.cloudformation.send(new DescribeStacksCommand({ StackName: stackName })),
      );
      if (output.ok) {
        return stackDescriptionOf(output.value);
      }
      return isMissingStack(output.error, stackName) ? ok(undefined) : output;
    },
    listStackResources: async (stack: string, nextToken?: string): PostDeployRead<StackResourcePage> => {
      const input = nextToken === undefined ? { StackName: stack } : { StackName: stack, NextToken: nextToken };
      const output = await settle(() => clients.cloudformation.send(new ListStackResourcesCommand(input)));
      return output.ok ? stackResourcePageOf(output.value) : output;
    },
    readFunctionConfiguration: async (
      functionName: string,
      qualifier: string,
    ): PostDeployRead<readonly AttributeReading[]> => {
      const command = new GetFunctionConfigurationCommand({ FunctionName: functionName, Qualifier: qualifier });
      const output = await settle(() => clients.lambda.send(command));
      return output.ok ? functionConfigurationOf(output.value) : output;
    },
    readEventSourceMapping: async (uuid: string): PostDeployRead<readonly AttributeReading[]> => {
      const output = await settle(() => clients.lambda.send(new GetEventSourceMappingCommand({ UUID: uuid })));
      return output.ok ? eventSourceMappingOf(output.value) : output;
    },
    readProvisionedConcurrency: async (
      functionName: string,
      qualifier: string,
    ): PostDeployRead<readonly AttributeReading[]> => {
      const command = new GetProvisionedConcurrencyConfigCommand({ FunctionName: functionName, Qualifier: qualifier });
      const output = await settle(() => clients.lambda.send(command));
      if (output.ok) {
        return provisionedConcurrencyOf(output.value);
      }
      return output.error.code === PROVISIONED_CONCURRENCY_NOT_FOUND ? ok(absentProvisionedConcurrency()) : output;
    },
    readQueueAttributes: async (queueUrl: string): PostDeployRead<readonly AttributeReading[]> => {
      const command = new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['All'] });
      const output = await settle(() => clients.sqs.send(command));
      return output.ok ? queueAttributesOf(output.value) : output;
    },
    readTable: async (tableName: string): PostDeployRead<readonly AttributeReading[]> => {
      const output = await settle(() => clients.dynamodb.send(new DescribeTableCommand({ TableName: tableName })));
      return output.ok ? tableDescriptionOf(output.value) : output;
    },
  };
}

async function settle<T>(call: () => Promise<T>): Promise<Result<T, PostDeployReadFailure>> {
  try {
    return ok(await call());
  } catch (error: unknown) {
    // An Error's name lives on its prototype unless the SDK set its own (service exceptions do).
    const name = error instanceof Error ? error.name : ownValue(error, 'name');
    const message = error instanceof Error ? error.message : ownValue(error, 'message');
    return err({
      code: boundedText(nonEmptyString(name) ?? 'UnknownError', MESSAGE_CHARACTERS),
      detail: boundedText(nonEmptyString(message) ?? 'no message', MESSAGE_CHARACTERS),
    });
  }
}
