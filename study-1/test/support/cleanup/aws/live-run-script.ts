// Scripts a ScriptedCleanupEndpoint as the AWS account of one live run (design §9.2, §9.14): the
// recorded stack and its resource listing, the provider and Durable caller functions (with a
// version, an alias and a running durable execution), the source mapping, the durable DLQ, the
// control table, the provider log group and role, each tagged with the run tags, and the tag
// index listing the taggable ones. A resource listed in `gone` answers "not found" on its native
// describe, as it does once deleted, except the stack: CloudFormation keeps describing a deleted
// stack by its unique id, as DELETE_COMPLETE. The discovery targets match `liveRunManifest()`.

import { tableName } from '../../../../infra/ownership/resource-naming.ts';
import type { ResourceTag } from '../../../../src/cleanup/discovery.ts';
import {
  FUNCTION_ALIAS_RESOURCE_TYPE,
  FUNCTION_VERSION_RESOURCE_TYPE,
} from '../../../../src/cleanup/resource-types.ts';
import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import type { ResourceManifest } from '../../../../src/record-contract/records/group-a/resource_manifest.ts';
import { EXECUTION_ID, NAMES, resourceManifest, runTags, STACK_ID, STACK_NAME } from '../cleanup-fixtures.ts';
import type { RecordedCleanupCall, ScriptedCleanupEndpoint, ScriptedReply } from './scripted-cleanup-endpoint.ts';
import { refuse, reply } from './scripted-cleanup-endpoint.ts';

export const ACCOUNT = '123456789012';
export const LIVE = {
  durableArn: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:${NAMES.durableFunction}`,
  providerArn: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:${NAMES.providerFunction}`,
  mappingArn: `arn:aws:lambda:us-east-1:${ACCOUNT}:event-source-mapping:${NAMES.sourceMapping}`,
  executionArn: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:${NAMES.durableFunction}:3/durable-execution/t-1/0f0e`,
  dlqName: NAMES.durableDlqUrl.slice(NAMES.durableDlqUrl.lastIndexOf('/') + 1),
  dlqArn: `arn:aws:sqs:us-east-1:${ACCOUNT}:${NAMES.durableDlqUrl.slice(NAMES.durableDlqUrl.lastIndexOf('/') + 1)}`,
  tableArn: `arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/${NAMES.controlTable}`,
  logGroupArn: `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:${NAMES.providerLogGroup}`,
  roleArn: `arn:aws:iam::${ACCOUNT}:role/${NAMES.providerRole}`,
  /** 2026-10-05T11:30:00Z, after the execution manifest froze. */
  createdEpochSeconds: 1_791_199_800,
} as const;

/** A native resource the script can report gone. */
export type LiveResource = 'stack' | 'functions' | 'mapping' | 'execution' | 'queue' | 'table' | 'log_group' | 'role';

/**
 * The run's succeeded manifest with the DLQ and Durable caller outputs and the caller's version
 * and alias.
 *
 * @example
 * discoveryTargetsOf({ manifest: liveRunManifest(), execution: EXECUTION });
 */
export function liveRunManifest(): ResourceManifest {
  const manifest = resourceManifest();
  return {
    ...manifest,
    resources: [
      ...manifest.resources,
      {
        logical_id: 'DurableCallerVersion',
        resource_type: FUNCTION_VERSION_RESOURCE_TYPE,
        physical_id: `${LIVE.durableArn}:3`,
        resource_status: 'CREATE_COMPLETE',
      },
      // The stack records the caller's `live` alias (infra durable-variant `addAlias`) under its
      // ARN, the identifier the functions surface reports for it; without this row the alias
      // the account lists reads as ambiguous rather than owned.
      {
        logical_id: 'DurableCallerAlias',
        resource_type: FUNCTION_ALIAS_RESOURCE_TYPE,
        physical_id: `${LIVE.durableArn}:live`,
        resource_status: 'CREATE_COMPLETE',
      },
    ],
    outputs: [
      { key: 'DurableDeadLetterQueueUrl', value: NAMES.durableDlqUrl },
      { key: 'DurableCallerFunctionName', value: NAMES.durableFunction },
    ],
  };
}

function tagMapOf(tags: readonly ResourceTag[]): JsonValue {
  return Object.fromEntries(tags.map((tag) => [tag.key, tag.value]));
}

function tagPairsOf(tags: readonly ResourceTag[]): JsonValue {
  return tags.map((tag) => ({ Key: tag.key, Value: tag.value }));
}

function tagsXml(tags: readonly ResourceTag[]): string {
  const members = tags.map((tag) => `<member><Key>${tag.key}</Key><Value>${tag.value}</Value></member>`).join('');
  return `<Tags>${members}</Tags>`;
}

function notFound(service: 'lambda' | 'sqs' | 'iam' | 'dynamodb'): ReturnType<typeof refuse> {
  const codes = {
    lambda: 'ResourceNotFoundException',
    sqs: 'QueueDoesNotExist',
    iam: 'NoSuchEntity',
    dynamodb: 'ResourceNotFoundException',
  };
  return refuse(codes[service], 'not found', service === 'sqs' ? 400 : 404);
}

/** What the scripted account holds; read at each call, so a test or a fake may change it. */
export interface LiveRunState {
  readonly gone: ReadonlySet<LiveResource>;
  /** The `State` the source mapping reports. */
  readonly mappingState: () => string;
}

/**
 * Scripts every read cleanup's surfaces send, for a live run; what is gone is read at each call.
 *
 * @example
 * scriptLiveRun(endpoint, { gone: new Set(['queue']), mappingState: () => 'Enabled' });
 */
export function scriptLiveRun(
  endpoint: ScriptedCleanupEndpoint,
  state: LiveRunState = { gone: new Set(), mappingState: () => 'Enabled' },
): void {
  const { gone } = state;
  const tags = runTags(EXECUTION_ID);
  scriptStack(endpoint, gone, tags);
  scriptLambda(endpoint, state, tags);
  scriptQueues(endpoint, gone, tags);
  endpoint.respond('dynamodb:DescribeTable', (call) =>
    call.input['TableName'] === NAMES.controlTable && !gone.has('table')
      ? reply({
          Table: { TableName: NAMES.controlTable, TableArn: LIVE.tableArn, CreationDateTime: LIVE.createdEpochSeconds },
        })
      : notFound('dynamodb'),
  );
  endpoint.answer('dynamodb:ListTagsOfResource', reply({ Tags: tagPairsOf(tags) }));
  const logGroup = {
    logGroupName: NAMES.providerLogGroup,
    arn: `${LIVE.logGroupArn}:*`,
    creationTime: LIVE.createdEpochSeconds * 1000,
  };
  endpoint.respond('logs:DescribeLogGroups', () => reply({ logGroups: gone.has('log_group') ? [] : [logGroup] }));
  endpoint.answer('logs:ListTagsForResource', reply({ tags: tagMapOf(tags) }));
  endpoint.respond('iam:GetRole', () =>
    gone.has('role')
      ? notFound('iam')
      : reply(
          `<Role><RoleName>${NAMES.providerRole}</RoleName><Arn>${LIVE.roleArn}</Arn><Path>/</Path><RoleId>AROA1</RoleId>` +
            '<CreateDate>2026-10-05T11:30:00Z</CreateDate></Role>',
        ),
  );
  endpoint.answer('iam:ListRoleTags', reply(`${tagsXml(tags)}<IsTruncated>false</IsTruncated>`));
  const indexed = [LIVE.tableArn, LIVE.dlqArn, LIVE.providerArn].map((arn) => ({
    ResourceARN: arn,
    Tags: tagPairsOf(tags),
  }));
  endpoint.respond('tagging:GetResources', () =>
    reply({ ResourceTagMappingList: gone.has('stack') ? [] : indexed, PaginationToken: '' }),
  );
}

/** The stack status `DescribeStacks` reports while the stack exists. */
export type LiveStackStatus = 'CREATE_COMPLETE' | 'DELETE_FAILED';

/**
 * `DescribeStacks` of the run's stack as CloudFormation answers it: by name or unique id while it
 * exists; once deleted, DELETE_COMPLETE by its unique id (kept for 90 days) and "does not exist"
 * by its name ("Deleted stacks: You must specify the unique stack ID", [R-aws] §6.3).
 *
 * @example
 * endpoint.respond('cloudformation:DescribeStacks', (call) => describeRunStack(call, 'CREATE_COMPLETE', tags));
 */
export function describeRunStack(
  call: RecordedCleanupCall,
  status: LiveStackStatus | 'DELETE_COMPLETE',
  tags: readonly ResourceTag[],
): ScriptedReply {
  const ref = String(call.input['StackName']);
  if (!stackAnswers(ref, status === 'DELETE_COMPLETE')) {
    return stackMissing(ref);
  }
  return reply(
    `<Stacks><member><StackId>${STACK_ID}</StackId><StackName>${STACK_NAME}</StackName>${tagsXml(tags)}` +
      `<CreationTime>2026-10-05T11:30:00.000Z</CreationTime><StackStatus>${status}</StackStatus></member></Stacks>`,
  );
}

// A live stack answers by name or id, a deleted one by its unique id only.
function stackAnswers(ref: string, deleted: boolean): boolean {
  return ref === STACK_ID || (!deleted && ref === STACK_NAME);
}

function stackMissing(ref: string): ScriptedReply {
  return refuse('ValidationError', `Stack with id ${ref} does not exist`);
}

// The stack's members: CREATE_COMPLETE while it exists, DELETE_COMPLETE once deleted (a deleted
// stack's resources and events stay listed by its unique id for 90 days).
function scriptStack(
  endpoint: ScriptedCleanupEndpoint,
  goneSet: ReadonlySet<LiveResource>,
  tags: readonly ResourceTag[],
): void {
  endpoint.respond('cloudformation:DescribeStacks', (call) =>
    describeRunStack(call, goneSet.has('stack') ? 'DELETE_COMPLETE' : 'CREATE_COMPLETE', tags),
  );
  const summary = (logical: string, type: string, physical: string, status: string): string =>
    `<member><LogicalResourceId>${logical}</LogicalResourceId><PhysicalResourceId>${physical}</PhysicalResourceId>` +
    `<ResourceType>${type}</ResourceType><ResourceStatus>${status}</ResourceStatus>` +
    '<LastUpdatedTimestamp>2026-10-05T11:30:00.000Z</LastUpdatedTimestamp></member>';
  endpoint.respond('cloudformation:ListStackResources', (call) => {
    const ref = String(call.input['StackName']);
    const status = goneSet.has('stack') ? 'DELETE_COMPLETE' : 'CREATE_COMPLETE';
    return stackAnswers(ref, goneSet.has('stack'))
      ? reply(
          `<StackResourceSummaries>${summary('ControlTable', 'AWS::DynamoDB::Table', NAMES.controlTable, status)}` +
            `${summary('ProviderRole', 'AWS::IAM::Role', NAMES.providerRole, status)}</StackResourceSummaries>`,
        )
      : stackMissing(ref);
  });
  const stackEvent =
    `<member><EventId>e-1</EventId><StackId>${STACK_ID}</StackId><StackName>${STACK_NAME}</StackName>` +
    `<LogicalResourceId>${STACK_NAME}</LogicalResourceId><PhysicalResourceId>${STACK_ID}</PhysicalResourceId>` +
    '<ResourceType>AWS::CloudFormation::Stack</ResourceType><ResourceStatus>DELETE_COMPLETE</ResourceStatus>' +
    '<Timestamp>2026-10-05T12:00:00.000Z</Timestamp></member>';
  endpoint.respond('cloudformation:DescribeStackEvents', (call) => {
    const ref = String(call.input['StackName']);
    if (!stackAnswers(ref, goneSet.has('stack'))) {
      return stackMissing(ref);
    }
    return reply(`<StackEvents>${goneSet.has('stack') ? stackEvent : ''}</StackEvents>`);
  });
}

function scriptLambda(endpoint: ScriptedCleanupEndpoint, state: LiveRunState, tags: readonly ResourceTag[]): void {
  const { gone } = state;
  const functions = new Map<string, string>([
    [NAMES.providerFunction, LIVE.providerArn],
    [NAMES.durableFunction, LIVE.durableArn],
  ]);
  endpoint.respond('lambda:GetFunction', (call) => {
    const name = String(call.input['FunctionName']);
    const arn = functions.get(name) ?? [...functions.values()].find((known) => name.startsWith(known));
    return arn === undefined || gone.has('functions')
      ? notFound('lambda')
      : reply({ Configuration: { FunctionName: name, FunctionArn: arn }, Tags: tagMapOf(tags) });
  });
  endpoint.answer('lambda:ListTags', reply({ Tags: tagMapOf(tags) }));
  endpoint.respond('lambda:ListVersionsByFunction', (call) =>
    reply({
      Versions:
        call.input['FunctionName'] === NAMES.durableFunction
          ? [
              { FunctionArn: `${LIVE.durableArn}:$LATEST`, Version: '$LATEST' },
              { FunctionArn: `${LIVE.durableArn}:3`, Version: '3' },
            ]
          : [],
    }),
  );
  endpoint.respond('lambda:ListAliases', (call) =>
    reply({
      Aliases:
        call.input['FunctionName'] === NAMES.durableFunction
          ? [{ AliasArn: `${LIVE.durableArn}:live`, Name: 'live', FunctionVersion: '3' }]
          : [],
    }),
  );
  const mapping = (): JsonValue => ({
    UUID: NAMES.sourceMapping,
    State: state.mappingState(),
    EventSourceMappingArn: LIVE.mappingArn,
  });
  endpoint.respond('lambda:ListEventSourceMappings', () =>
    reply({ EventSourceMappings: gone.has('mapping') ? [] : [mapping()] }),
  );
  endpoint.respond('lambda:GetEventSourceMapping', () => (gone.has('mapping') ? notFound('lambda') : reply(mapping())));
  const execution = {
    DurableExecutionArn: LIVE.executionArn,
    DurableExecutionName: 't-1',
    Status: 'RUNNING',
    StartTimestamp: LIVE.createdEpochSeconds,
  };
  endpoint.respond('lambda:ListDurableExecutionsByFunction', () =>
    reply({ DurableExecutions: gone.has('execution') ? [] : [execution] }),
  );
}

function scriptQueues(
  endpoint: ScriptedCleanupEndpoint,
  goneSet: ReadonlySet<LiveResource>,
  tags: readonly ResourceTag[],
): void {
  const gone = (): boolean => goneSet.has('queue');
  endpoint.respond('sqs:GetQueueUrl', () => (gone() ? notFound('sqs') : reply({ QueueUrl: NAMES.durableDlqUrl })));
  endpoint.respond('sqs:ListQueues', () => reply(gone() ? {} : { QueueUrls: [NAMES.durableDlqUrl] }));
  endpoint.answer('sqs:ListQueueTags', reply({ Tags: tagMapOf(tags) }));
  endpoint.respond('sqs:GetQueueAttributes', () =>
    gone()
      ? notFound('sqs')
      : reply({ Attributes: { CreatedTimestamp: String(LIVE.createdEpochSeconds), QueueArn: LIVE.dlqArn } }),
  );
}

/** The five deterministic table names (design §9.7); only the control table exists. */
export const OTHER_TABLE_NAMES = ['ledger', 'experiment-journal', 'caller-journal', 'trial-registry'].map((role) =>
  tableName(EXECUTION_ID, role as Parameters<typeof tableName>[1]),
);
