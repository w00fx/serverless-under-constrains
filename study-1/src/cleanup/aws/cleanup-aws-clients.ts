// The SDK clients cleanup acts through (design §9.4, §10.4): one factory per service, each built
// for the study Region with `maxAttempts: 1`. A hidden retry would re-send a delete or a receive
// that already happened, so every retry decision stays explicit in cleanup (BR-RUA-048 runs again
// instead). Tests pass a scripted `requestHandler` and static credentials; production passes
// nothing.

import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import type { CloudFormationClientConfig } from '@aws-sdk/client-cloudformation';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import type { CloudWatchLogsClientConfig } from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { IAMClient } from '@aws-sdk/client-iam';
import type { IAMClientConfig } from '@aws-sdk/client-iam';
import { LambdaClient } from '@aws-sdk/client-lambda';
import type { LambdaClientConfig } from '@aws-sdk/client-lambda';
import { ResourceGroupsTaggingAPIClient } from '@aws-sdk/client-resource-groups-tagging-api';
import type { ResourceGroupsTaggingAPIClientConfig } from '@aws-sdk/client-resource-groups-tagging-api';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { SQSClientConfig } from '@aws-sdk/client-sqs';

export const CLEANUP_CLIENT_OPTIONS = { region: 'us-east-1', maxAttempts: 1 } as const;
const PINNED_SETTING_NAMES: ReadonlySet<string> = new Set(['region', 'maxAttempts', 'retryStrategy', 'retryMode']);
type PinnedSetting = 'region' | 'maxAttempts' | 'retryStrategy' | 'retryMode';

/** Client settings a caller may supply to every cleanup client; Region and retries are fixed. */
export type CleanupClientSettings = Omit<LambdaClientConfig, PinnedSetting> &
  Omit<SQSClientConfig, PinnedSetting> &
  Omit<CloudFormationClientConfig, PinnedSetting> &
  Omit<DynamoDBClientConfig, PinnedSetting> &
  Omit<CloudWatchLogsClientConfig, PinnedSetting> &
  Omit<IAMClientConfig, PinnedSetting> &
  Omit<ResourceGroupsTaggingAPIClientConfig, PinnedSetting>;

/** The seven clients of cleanup's adapters. */
export interface CleanupAwsClients {
  readonly lambda: LambdaClient;
  readonly sqs: SQSClient;
  readonly cloudformation: CloudFormationClient;
  readonly dynamodb: DynamoDBClient;
  readonly logs: CloudWatchLogsClient;
  readonly iam: IAMClient;
  readonly tagging: ResourceGroupsTaggingAPIClient;
}

/**
 * The Lambda client of cleanup (mappings, durable executions, functions).
 *
 * @example
 * const lambda = createCleanupLambdaClient();
 */
export function createCleanupLambdaClient(settings: Omit<LambdaClientConfig, PinnedSetting> = {}): LambdaClient {
  return new LambdaClient(pinnedConfig(settings));
}

/**
 * The SQS client of cleanup (DLQ messages, queues).
 *
 * @example
 * const sqs = createCleanupSqsClient();
 */
export function createCleanupSqsClient(settings: Omit<SQSClientConfig, PinnedSetting> = {}): SQSClient {
  return new SQSClient(pinnedConfig(settings));
}

/**
 * The CloudFormation client of cleanup (the recorded stack, its resources and events).
 *
 * @example
 * const cloudformation = createCleanupCloudFormationClient();
 */
export function createCleanupCloudFormationClient(
  settings: Omit<CloudFormationClientConfig, PinnedSetting> = {},
): CloudFormationClient {
  return new CloudFormationClient(pinnedConfig(settings));
}

/**
 * The DynamoDB client of cleanup (run-owned tables).
 *
 * @example
 * const dynamodb = createCleanupDynamoDbClient();
 */
export function createCleanupDynamoDbClient(settings: Omit<DynamoDBClientConfig, PinnedSetting> = {}): DynamoDBClient {
  return new DynamoDBClient(pinnedConfig(settings));
}

/**
 * The CloudWatch Logs client of cleanup (the execution's log groups).
 *
 * @example
 * const logs = createCleanupLogsClient();
 */
export function createCleanupLogsClient(
  settings: Omit<CloudWatchLogsClientConfig, PinnedSetting> = {},
): CloudWatchLogsClient {
  return new CloudWatchLogsClient(pinnedConfig(settings));
}

/**
 * The IAM client of cleanup (run-owned roles).
 *
 * @example
 * const iam = createCleanupIamClient();
 */
export function createCleanupIamClient(settings: Omit<IAMClientConfig, PinnedSetting> = {}): IAMClient {
  return new IAMClient(pinnedConfig(settings));
}

/**
 * The Resource Groups Tagging API client of cleanup (the tag index).
 *
 * @example
 * const tagging = createCleanupTaggingClient();
 */
export function createCleanupTaggingClient(
  settings: Omit<ResourceGroupsTaggingAPIClientConfig, PinnedSetting> = {},
): ResourceGroupsTaggingAPIClient {
  return new ResourceGroupsTaggingAPIClient(pinnedConfig(settings));
}

/**
 * All seven clients with the same settings.
 *
 * @example
 * const clients = createCleanupAwsClients();
 */
export function createCleanupAwsClients(settings: CleanupClientSettings = {}): CleanupAwsClients {
  return {
    lambda: createCleanupLambdaClient(settings),
    sqs: createCleanupSqsClient(settings),
    cloudformation: createCleanupCloudFormationClient(settings),
    dynamodb: createCleanupDynamoDbClient(settings),
    logs: createCleanupLogsClient(settings),
    iam: createCleanupIamClient(settings),
    tagging: createCleanupTaggingClient(settings),
  };
}

// A cast can smuggle a pinned key past the type, and a smuggled `retryStrategy` would bring
// retries back while `maxAttempts` still reads 1, so pinned keys are dropped at run time too.
function pinnedConfig<T extends object>(settings: T): T & typeof CLEANUP_CLIENT_OPTIONS {
  const allowed = Object.fromEntries(Object.entries(settings).filter(([name]) => !PINNED_SETTING_NAMES.has(name)));
  return { ...(allowed as T), ...CLEANUP_CLIENT_OPTIONS };
}
