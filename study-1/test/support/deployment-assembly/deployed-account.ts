// A deployed execution stack as the AWS read APIs answer it (design §9.8 D4): the DescribeStacks
// stack member, the ListStackResources summaries, and the GetFunctionConfiguration,
// GetEventSourceMapping, GetProvisionedConcurrencyConfig, GetQueueAttributes and DescribeTable
// outputs of every resource a frozen template declares, keyed by the identifiers each request
// names. Both FakePostDeployReader and ScriptedPostDeployEndpoint answer from one such account,
// which is what makes their differential conformance test meaningful.
// Physical ids follow the form CloudFormation documents as each type's `Ref` value: a Lambda
// version or alias ARN, an event-source-mapping UUID, a queue URL and a table name. Fixture
// values, not cloud evidence; the real forms stay UNVERIFIED until the cloud phase.

import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import type { KeyValueEntry } from '../../../src/record-contract/records/group-a/resource_manifest.ts';

export const DEPLOYED_ACCOUNT_ID = '123456789012';
export const DEPLOYED_PROVIDER_VERSION = '7';
const NAME_PREFIX = 'suc1-3f1c2a9e-';
const LAMBDA_ARN_PREFIX = `arn:aws:lambda:us-east-1:${DEPLOYED_ACCOUNT_ID}:function:`;
const QUEUE_URL_PREFIX = `https://sqs.us-east-1.amazonaws.com/${DEPLOYED_ACCOUNT_ID}/`;

type MutableObject = Record<string, JsonValue>;

/** Every answer of one deployed stack; tests change members to script a different account. */
export interface DeployedAccount {
  stack_name: string;
  /** The DescribeStacks stack member; `undefined` when the stack does not exist. */
  stack: MutableObject | undefined;
  /** ListStackResources summaries, answered `page_size` per page. */
  resources: Record<string, string>[];
  page_size: number;
  /** GetFunctionConfiguration outputs by `<function name>:<qualifier>`. */
  functions: Record<string, MutableObject>;
  /** GetEventSourceMapping outputs by UUID. */
  mappings: Record<string, MutableObject>;
  /** GetProvisionedConcurrencyConfig outputs by `<function name>:<qualifier>`; none by default. */
  concurrency: Record<string, MutableObject>;
  /** GetQueueAttributes `Attributes` by queue URL. */
  queues: Record<string, Record<string, string>>;
  /** DescribeTable `Table` members by table name. */
  tables: Record<string, MutableObject>;
}

interface TemplateResource {
  readonly Type: string;
  readonly Properties?: JsonObject;
}

/**
 * The account in which `template` deployed as `stackId` with `tags`, every resource complete and
 * the provider published as version 7.
 *
 * @example
 * const account = deployedAccount(runTemplate(), RUN_STACK, stackIdOf(RUN_STACK), declaredTags());
 * account.functions['suc1-3f1c2a9e-providerfunction:7']?.['Version']; // '7'
 */
export function deployedAccount(
  template: JsonObject,
  stackName: string,
  stackId: string,
  tags: readonly KeyValueEntry[],
): DeployedAccount {
  const resources = template['Resources'] as unknown as Readonly<Record<string, TemplateResource>>;
  const physical = physicalIds(resources);
  const account: DeployedAccount = {
    stack_name: stackName,
    stack: {
      StackName: stackName,
      StackId: stackId,
      StackStatus: 'CREATE_COMPLETE',
      Tags: tags.map((tag) => ({ Key: tag.key, Value: tag.value })),
    },
    resources: Object.entries(resources).map(([logicalId, resource]) => ({
      LogicalResourceId: logicalId,
      PhysicalResourceId: physical.get(logicalId) ?? '',
      ResourceType: resource.Type,
      ResourceStatus: 'CREATE_COMPLETE',
    })),
    page_size: 100,
    functions: {},
    mappings: {},
    concurrency: {},
    queues: {},
    tables: {},
  };
  for (const [logicalId, resource] of Object.entries(resources)) {
    answerResource(account, resources, physical, logicalId, resource);
  }
  return account;
}

/**
 * A CloudFormation stack id of `stackName`.
 *
 * @example
 * stackIdOf('SucRua-run-3f1c2a9e'); // 'arn:aws:cloudformation:us-east-1:123456789012:stack/SucRua-run-3f1c2a9e/0a1b2c3d-…'
 */
export function stackIdOf(stackName: string): string {
  return `arn:aws:cloudformation:us-east-1:${DEPLOYED_ACCOUNT_ID}:stack/${stackName}/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d`;
}

/**
 * The physical name a deployed resource of `logicalId` has.
 *
 * @example
 * functionNameOf('ProviderFunction'); // 'suc1-3f1c2a9e-providerfunction'
 */
export function functionNameOf(logicalId: string): string {
  return `${NAME_PREFIX}${logicalId.toLowerCase()}`;
}

function physicalIds(resources: Readonly<Record<string, TemplateResource>>): Map<string, string> {
  const ids = new Map<string, string>();
  let mappings = 0;
  for (const [logicalId, resource] of Object.entries(resources)) {
    const target = referencedFunction(resource);
    mappings += resource.Type === 'AWS::Lambda::EventSourceMapping' ? 1 : 0;
    ids.set(logicalId, physicalIdOf(logicalId, resource, target, mappings));
  }
  return ids;
}

function physicalIdOf(logicalId: string, resource: TemplateResource, target: string, mapping: number): string {
  switch (resource.Type) {
    case 'AWS::Lambda::Version':
      return `${LAMBDA_ARN_PREFIX}${functionNameOf(target)}:${DEPLOYED_PROVIDER_VERSION}`;
    case 'AWS::Lambda::Alias':
      return `${LAMBDA_ARN_PREFIX}${functionNameOf(target)}:${aliasName(resource)}`;
    case 'AWS::Lambda::EventSourceMapping':
      return `5a0e1c2d-0000-4000-8000-${String(mapping).padStart(12, '0')}`;
    case 'AWS::SQS::Queue':
      return `${QUEUE_URL_PREFIX}${functionNameOf(logicalId)}${resource.Properties?.['FifoQueue'] === true ? '.fifo' : ''}`;
    default:
      return functionNameOf(logicalId);
  }
}

function aliasName(resource: TemplateResource): string {
  const name = resource.Properties?.['Name'];
  return typeof name === 'string' ? name : 'live';
}

function referencedFunction(resource: TemplateResource): string {
  const name = resource.Properties?.['FunctionName'];
  const reference =
    typeof name === 'object' && name !== null && !Array.isArray(name) ? (name as JsonObject)['Ref'] : undefined;
  return typeof reference === 'string' ? reference : '';
}

function answerResource(
  account: DeployedAccount,
  resources: Readonly<Record<string, TemplateResource>>,
  physical: ReadonlyMap<string, string>,
  logicalId: string,
  resource: TemplateResource,
): void {
  const id = physical.get(logicalId) ?? '';
  const properties = resource.Properties ?? {};
  if (resource.Type === 'AWS::Lambda::Version') {
    const target = referencedFunction(resource);
    const configuration = resources[target]?.Properties ?? {};
    account.functions[`${functionNameOf(target)}:${DEPLOYED_PROVIDER_VERSION}`] = functionAnswer(target, configuration);
  }
  if (resource.Type === 'AWS::Lambda::EventSourceMapping') {
    account.mappings[id] = mappingAnswer(id, properties);
  }
  if (resource.Type === 'AWS::SQS::Queue') {
    account.queues[id] = queueAnswer(logicalId, properties);
  }
  if (resource.Type === 'AWS::DynamoDB::Table') {
    account.tables[id] = tableAnswer(id, properties);
  }
}

function functionAnswer(logicalId: string, properties: JsonObject): MutableObject {
  const environment = properties['Environment'] as JsonObject | undefined;
  const variables = (environment?.['Variables'] ?? {}) as JsonObject;
  return {
    FunctionName: functionNameOf(logicalId),
    FunctionArn: `${LAMBDA_ARN_PREFIX}${functionNameOf(logicalId)}:${DEPLOYED_PROVIDER_VERSION}`,
    Runtime: properties['Runtime'] ?? null,
    Architectures: properties['Architectures'] ?? null,
    MemorySize: properties['MemorySize'] ?? null,
    Timeout: properties['Timeout'] ?? null,
    Version: DEPLOYED_PROVIDER_VERSION,
    Environment: {
      Variables: Object.fromEntries(Object.keys(variables).map((key) => [key, 'resolved'])),
    },
  };
}

function mappingAnswer(uuid: string, properties: JsonObject): MutableObject {
  const copied = Object.entries(properties).filter(([, value]) => !hasIntrinsic(value));
  return {
    UUID: uuid,
    State: 'Enabled',
    FunctionArn: `${LAMBDA_ARN_PREFIX}${NAME_PREFIX}mapped:live`,
    EventSourceArn: `arn:aws:sqs:us-east-1:${DEPLOYED_ACCOUNT_ID}:${NAME_PREFIX}source.fifo`,
    ...Object.fromEntries(copied),
  };
}

function queueAnswer(logicalId: string, properties: JsonObject): Record<string, string> {
  const fifo = properties['FifoQueue'] === true;
  return {
    QueueArn: `arn:aws:sqs:us-east-1:${DEPLOYED_ACCOUNT_ID}:${functionNameOf(logicalId)}${fifo ? '.fifo' : ''}`,
    VisibilityTimeout: JSON.stringify(properties['VisibilityTimeout'] ?? 30),
    ...(fifo
      ? {
          FifoQueue: 'true',
          ContentBasedDeduplication: JSON.stringify(properties['ContentBasedDeduplication'] ?? false),
        }
      : {}),
    ...(properties['RedrivePolicy'] === undefined
      ? {}
      : {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: `arn:aws:sqs:us-east-1:${DEPLOYED_ACCOUNT_ID}:${NAME_PREFIX}dlq.fifo`,
            maxReceiveCount: 2,
          }),
        }),
  };
}

function tableAnswer(tableName: string, properties: JsonObject): MutableObject {
  const stream = properties['StreamSpecification'] as JsonObject | undefined;
  return {
    TableName: tableName,
    TableStatus: 'ACTIVE',
    ...(stream === undefined ? {} : { StreamSpecification: { StreamEnabled: true, ...stream } }),
    BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
  };
}

function hasIntrinsic(value: JsonValue): boolean {
  const text = JSON.stringify(value);
  return text.includes('"Fn::') || text.includes('"Ref":');
}
