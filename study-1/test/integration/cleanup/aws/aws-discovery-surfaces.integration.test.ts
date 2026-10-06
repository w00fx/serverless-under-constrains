// AwsDiscoverySurfaces over the real clients (BR-RUA-051, design §9.14): the ten leak-audit
// surfaces of one execution read through the APIs each names, every resource named by the physical
// id CloudFormation records, tags read for ownership, a resource the service no longer knows not
// sighted, any other failure a failed surface; and the native describe that confirms or drops a
// tag-index entry.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AwsDiscoverySurfaces } from '../../../../src/cleanup/aws/aws-discovery-surfaces.ts';
import type { DiscoveredResource, SurfaceQueryResult } from '../../../../src/cleanup/discovery.ts';
import type { DiscoveryTargets } from '../../../../src/cleanup/discovery-targets.ts';
import { discoveryTargetsOf } from '../../../../src/cleanup/discovery-targets.ts';
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
import { STACK_LISTING_TAGS } from '../../../../src/cleanup/surface-readings-services.ts';
import type { UtcMillis } from '../../../../src/record-contract/primitives.ts';
import { LEAK_AUDIT_SURFACES } from '../../../../src/record-contract/records/group-c/vocabulary.ts';
import {
  LIVE,
  liveRunManifest,
  OTHER_TABLE_NAMES,
  scriptLiveRun,
} from '../../../support/cleanup/aws/live-run-script.ts';
import type { LiveResource } from '../../../support/cleanup/aws/live-run-script.ts';
import { refuse, reply, ScriptedCleanupEndpoint } from '../../../support/cleanup/aws/scripted-cleanup-endpoint.ts';
import {
  EXECUTION,
  EXECUTION_ID,
  NAMES,
  runTags,
  STACK_ID,
  tagged,
} from '../../../support/cleanup/cleanup-fixtures.ts';

const CREATED = '2026-10-05T11:30:00.000Z' as UtcMillis;

function liveTargets(): DiscoveryTargets {
  const targets = discoveryTargetsOf({ manifest: liveRunManifest(), execution: EXECUTION });
  if (!targets.ok) {
    throw new Error(`fixture manifest refused: ${targets.error.detail}; expected discovery targets`);
  }
  return targets.value;
}

function liveSurfaces(gone: readonly LiveResource[] = []): {
  surfaces: AwsDiscoverySurfaces;
  endpoint: ScriptedCleanupEndpoint;
} {
  const endpoint = new ScriptedCleanupEndpoint();
  scriptLiveRun(endpoint, { gone: new Set(gone), mappingState: () => 'Enabled' });
  return { surfaces: new AwsDiscoverySurfaces(endpoint.clients, liveTargets()), endpoint };
}

function resourcesOf(result: SurfaceQueryResult): readonly DiscoveredResource[] {
  assert.ok(result.ok, result.ok ? '' : `${result.reason.code}: ${result.reason.detail}`);
  return result.resources;
}

describe('AwsDiscoverySurfaces.query on a live run', () => {
  it('tag_index lists every ARN tagged with the run and study ids', async () => {
    const { surfaces, endpoint } = liveSurfaces();
    const resources = resourcesOf(await surfaces.query('tag_index'));
    assert.deepEqual(
      resources.map((resource) => [resource.resource_type, resource.identifier, resource.surface]),
      [
        [TABLE_RESOURCE_TYPE, LIVE.tableArn, 'tag_index'],
        [QUEUE_RESOURCE_TYPE, LIVE.dlqArn, 'tag_index'],
        [FUNCTION_RESOURCE_TYPE, LIVE.providerArn, 'tag_index'],
      ],
    );
    assert.deepEqual(resources[0]?.tags, tagged(runTags()));
    assert.deepEqual(endpoint.calls('tagging:GetResources')[0]?.input, {
      TagFilters: [
        { Key: 'suc:run_id', Values: [EXECUTION_ID] },
        { Key: 'suc:study_id', Values: ['study-1'] },
      ],
    });
  });

  it('stack sights the recorded stack with its tags and creation time, by recorded id', async () => {
    const { surfaces, endpoint } = liveSurfaces();
    assert.deepEqual(resourcesOf(await surfaces.query('stack')), [
      {
        resource_type: STACK_RESOURCE_TYPE,
        identifier: STACK_ID,
        surface: 'stack',
        tags: tagged(runTags()),
        created_at: CREATED,
      },
    ]);
    assert.equal(endpoint.calls('cloudformation:DescribeStacks')[0]?.input['StackName'], STACK_ID);
  });

  it('stack_resources lists what the stack manages, owned through it, without tags', async () => {
    const { surfaces, endpoint } = liveSurfaces();
    const resources = resourcesOf(await surfaces.query('stack_resources'));
    assert.deepEqual(resources, [
      {
        resource_type: TABLE_RESOURCE_TYPE,
        identifier: NAMES.controlTable,
        surface: 'stack_resources',
        tags: STACK_LISTING_TAGS,
        managed_by_stack_id: STACK_ID,
      },
      {
        resource_type: ROLE_RESOURCE_TYPE,
        identifier: NAMES.providerRole,
        surface: 'stack_resources',
        tags: STACK_LISTING_TAGS,
        managed_by_stack_id: STACK_ID,
      },
    ]);
    assert.deepEqual(
      endpoint.operations().filter((operation) => operation.startsWith('cloudformation')),
      ['cloudformation:ListStackResources', 'cloudformation:DescribeStackEvents'],
    );
  });

  it('functions sights each recorded function with its tags, versions and aliases', async () => {
    const { surfaces } = liveSurfaces();
    const resources = resourcesOf(await surfaces.query('functions'));
    assert.deepEqual(
      resources.map((resource) => [resource.resource_type, resource.identifier, resource.tags.kind]),
      [
        [FUNCTION_RESOURCE_TYPE, NAMES.providerFunction, 'tagged'],
        [FUNCTION_RESOURCE_TYPE, NAMES.durableFunction, 'tagged'],
        [FUNCTION_VERSION_RESOURCE_TYPE, `${LIVE.durableArn}:3`, 'untaggable'],
        [FUNCTION_ALIAS_RESOURCE_TYPE, `${LIVE.durableArn}:live`, 'untaggable'],
      ],
    );
  });

  it('event_source_mappings sights each mapping once, by UUID, with its tags', async () => {
    const { surfaces, endpoint } = liveSurfaces();
    assert.deepEqual(resourcesOf(await surfaces.query('event_source_mappings')), [
      {
        resource_type: EVENT_SOURCE_MAPPING_RESOURCE_TYPE,
        identifier: NAMES.sourceMapping,
        surface: 'event_source_mappings',
        tags: tagged(runTags()),
      },
    ]);
    assert.deepEqual(
      endpoint.calls('lambda:ListEventSourceMappings').map((call) => call.input),
      [
        { FunctionName: NAMES.providerFunction },
        { FunctionName: NAMES.durableFunction },
        { EventSourceArn: LIVE.dlqArn },
      ],
    );
    assert.deepEqual(
      endpoint.calls('lambda:ListTags').map((call) => call.input['Resource']),
      [LIVE.mappingArn],
    );
  });

  it('durable_executions sights each RUNNING execution once, owned through the recorded stack', async () => {
    const { surfaces, endpoint } = liveSurfaces();
    assert.deepEqual(resourcesOf(await surfaces.query('durable_executions')), [
      {
        resource_type: DURABLE_EXECUTION_RESOURCE_TYPE,
        identifier: LIVE.executionArn,
        surface: 'durable_executions',
        tags: { kind: 'untaggable' },
        created_at: CREATED,
        managed_by_stack_id: STACK_ID,
      },
    ]);
    assert.deepEqual(
      endpoint.calls('lambda:ListDurableExecutionsByFunction').map((call) => call.input['Qualifier']),
      [undefined, '3'],
    );
  });

  it('queues sights each queue once, by URL, with its tags and creation time', async () => {
    const { surfaces, endpoint } = liveSurfaces();
    assert.deepEqual(resourcesOf(await surfaces.query('queues')), [
      {
        resource_type: QUEUE_RESOURCE_TYPE,
        identifier: NAMES.durableDlqUrl,
        surface: 'queues',
        tags: tagged(runTags()),
        created_at: CREATED,
      },
    ]);
    assert.deepEqual(endpoint.calls('sqs:ListQueues')[0]?.input, {
      QueueNamePrefix: 'suc1-aaaaaaaa-',
      MaxResults: 1000,
    });
    assert.deepEqual(endpoint.calls('sqs:GetQueueUrl')[0]?.input, { QueueName: LIVE.dlqName });
  });

  it('tables, log_groups and roles sight what exists by name, with tags and creation time', async () => {
    const { surfaces, endpoint } = liveSurfaces();
    const named = (
      resourceType: string,
      identifier: string,
      surface: DiscoveredResource['surface'],
    ): DiscoveredResource => ({
      resource_type: resourceType,
      identifier,
      surface,
      tags: tagged(runTags()),
      created_at: CREATED,
    });
    assert.deepEqual(resourcesOf(await surfaces.query('tables')), [
      named(TABLE_RESOURCE_TYPE, NAMES.controlTable, 'tables'),
    ]);
    assert.deepEqual(
      endpoint
        .calls('dynamodb:DescribeTable')
        .map((call) => call.input['TableName'])
        .sort(),
      [NAMES.controlTable, ...OTHER_TABLE_NAMES].sort(),
    );
    assert.deepEqual(resourcesOf(await surfaces.query('log_groups')), [
      named(LOG_GROUP_RESOURCE_TYPE, NAMES.providerLogGroup, 'log_groups'),
    ]);
    assert.deepEqual(endpoint.calls('logs:ListTagsForResource')[0]?.input, { resourceArn: LIVE.logGroupArn });
    assert.deepEqual(resourcesOf(await surfaces.query('roles')), [
      named(ROLE_RESOURCE_TYPE, NAMES.providerRole, 'roles'),
    ]);
  });

  it('answers every surface of the catalogue', async () => {
    const { surfaces } = liveSurfaces();
    for (const surface of LEAK_AUDIT_SURFACES) {
      assert.equal((await surfaces.query(surface)).ok, true, surface);
    }
  });
});

describe('AwsDiscoverySurfaces.query once resources are gone', () => {
  it('sights nothing that the native APIs report gone', async () => {
    const { surfaces } = liveSurfaces([
      'stack',
      'functions',
      'mapping',
      'execution',
      'queue',
      'table',
      'log_group',
      'role',
    ]);
    for (const surface of LEAK_AUDIT_SURFACES.filter((name) => name !== 'tag_index')) {
      assert.deepEqual(resourcesOf(await surfaces.query(surface)), [], surface);
    }
  });

  it('reads the stack by name when provisioning never recorded its id', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    scriptLiveRun(endpoint);
    const surfaces = new AwsDiscoverySurfaces(endpoint.clients, {
      ...liveTargets(),
      stack_ref: 'SucRua-run-aaaaaaaa',
      recorded_stack_id: undefined,
    } as unknown as DiscoveryTargets);
    const listed = resourcesOf(await surfaces.query('stack_resources'));
    assert.equal(listed.length, 2);
    assert.deepEqual(
      endpoint.calls().map((call) => [call.operation, call.input['StackName']]),
      [
        ['DescribeStacks', 'SucRua-run-aaaaaaaa'],
        ['ListStackResources', STACK_ID],
        ['DescribeStackEvents', STACK_ID],
      ],
    );
  });
});

describe('AwsDiscoverySurfaces.query failures', () => {
  it('fails a surface whose read fails or whose answer does not read', async () => {
    const { surfaces, endpoint } = liveSurfaces();
    endpoint.answer('tagging:GetResources', refuse('ThrottledException', 'slow down'));
    endpoint.answer('logs:DescribeLogGroups', reply({ logGroups: [{ logGroupName: 'g' }] }));
    const index = await surfaces.query('tag_index');
    assert.deepEqual(index, {
      ok: false,
      reason: {
        code: 'THROTTLED_EXCEPTION',
        subject: 'tag_index',
        detail: 'ThrottledException: slow down; expected a tag-index listing',
      },
    });
    const logGroups = await surfaces.query('log_groups');
    assert.equal(!logGroups.ok && logGroups.reason.code, 'SDK_OUTPUT_MALFORMED');
  });

  it('keeps a resource whose tags could not be read, with its ownership unknown', async () => {
    const { surfaces, endpoint } = liveSurfaces();
    endpoint.answer('sqs:ListQueueTags', refuse('AccessDenied', 'denied', 403));
    const [queue] = resourcesOf(await surfaces.query('queues'));
    assert.equal(queue?.tags.kind === 'unknown' && queue.tags.reason.code, 'ACCESS_DENIED');
  });

  it('marks the tags of a mapping listed without its ARN as unknown', async () => {
    const { surfaces, endpoint } = liveSurfaces();
    endpoint.answer(
      'lambda:ListEventSourceMappings',
      reply({ EventSourceMappings: [{ UUID: 'u-2', State: 'Enabled' }] }),
    );
    endpoint.answer('lambda:GetEventSourceMapping', refuse('ResourceNotFoundException', 'gone', 404));
    const [mapping] = resourcesOf(await surfaces.query('event_source_mappings'));
    assert.equal(mapping?.tags.kind === 'unknown' && mapping.tags.reason.code, 'MAPPING_ARN_NOT_LISTED');
  });

  it('fails a durable listing whose cursor repeats', async () => {
    const { surfaces, endpoint } = liveSurfaces();
    endpoint.answer('lambda:ListDurableExecutionsByFunction', reply({ DurableExecutions: [], NextMarker: 'same' }));
    const durable = await surfaces.query('durable_executions');
    assert.equal(!durable.ok && durable.reason.code, 'PAGINATION_CURSOR_REPEATED');
  });
});

describe('AwsDiscoverySurfaces.confirmPresence', () => {
  const entries = (): DiscoveredResource[] => [
    tagIndexEntry(STACK_RESOURCE_TYPE, STACK_ID),
    tagIndexEntry(FUNCTION_RESOURCE_TYPE, LIVE.providerArn),
    tagIndexEntry(FUNCTION_VERSION_RESOURCE_TYPE, `${LIVE.durableArn}:3`),
    tagIndexEntry(FUNCTION_ALIAS_RESOURCE_TYPE, `${LIVE.durableArn}:live`),
    tagIndexEntry(EVENT_SOURCE_MAPPING_RESOURCE_TYPE, LIVE.mappingArn),
    tagIndexEntry(QUEUE_RESOURCE_TYPE, LIVE.dlqArn),
    tagIndexEntry(TABLE_RESOURCE_TYPE, LIVE.tableArn),
    tagIndexEntry(LOG_GROUP_RESOURCE_TYPE, LIVE.logGroupArn),
    tagIndexEntry(ROLE_RESOURCE_TYPE, NAMES.providerRole),
  ];

  function tagIndexEntry(resourceType: string, identifier: string): DiscoveredResource {
    return { resource_type: resourceType, identifier, surface: 'tag_index', tags: tagged(runTags()) };
  }

  it('confirms every live type through its native describe', async () => {
    const { surfaces, endpoint } = liveSurfaces();
    for (const entry of entries()) {
      assert.deepEqual(await surfaces.confirmPresence(entry), { kind: 'present' }, entry.resource_type);
    }
    assert.deepEqual(endpoint.operations(), [
      'cloudformation:DescribeStacks',
      'lambda:GetFunction',
      'lambda:GetFunction',
      'lambda:GetFunction',
      'lambda:GetEventSourceMapping',
      'sqs:GetQueueAttributes',
      'dynamodb:DescribeTable',
      'logs:DescribeLogGroups',
      'iam:GetRole',
    ]);
    assert.deepEqual(endpoint.calls('sqs:GetQueueAttributes')[0]?.input, {
      QueueUrl: NAMES.durableDlqUrl,
      AttributeNames: ['QueueArn'],
    });
    assert.deepEqual(endpoint.calls('logs:DescribeLogGroups')[0]?.input, {
      logGroupNamePrefix: NAMES.providerLogGroup,
    });
  });

  it('reports a stale tag-index entry absent', async () => {
    const { surfaces } = liveSurfaces(['stack', 'functions', 'mapping', 'queue', 'table', 'log_group', 'role']);
    for (const entry of entries()) {
      assert.deepEqual(await surfaces.confirmPresence(entry), { kind: 'absent' }, entry.resource_type);
    }
  });

  it('reads a DELETE_COMPLETE stack absent and a log group listed only by a longer name absent', async () => {
    const { surfaces, endpoint } = liveSurfaces();
    endpoint.answer(
      'cloudformation:DescribeStacks',
      reply(
        `<Stacks><member><StackId>${STACK_ID}</StackId><StackName>n</StackName><StackStatus>DELETE_COMPLETE</StackStatus><CreationTime>2026-10-05T11:00:00Z</CreationTime></member></Stacks>`,
      ),
    );
    endpoint.answer(
      'logs:DescribeLogGroups',
      reply({ logGroups: [{ logGroupName: `${NAMES.providerLogGroup}-2`, arn: 'a' }] }),
    );
    assert.deepEqual(await surfaces.confirmPresence(tagIndexEntry(STACK_RESOURCE_TYPE, STACK_ID)), { kind: 'absent' });
    assert.deepEqual(await surfaces.confirmPresence(tagIndexEntry(LOG_GROUP_RESOURCE_TYPE, LIVE.logGroupArn)), {
      kind: 'absent',
    });
  });

  it('reports a failed describe failed, and an entry it cannot describe present', async () => {
    const { surfaces, endpoint } = liveSurfaces();
    endpoint.answer('dynamodb:DescribeTable', refuse('InternalServerError', 'down', 500));
    const table = await surfaces.confirmPresence(tagIndexEntry(TABLE_RESOURCE_TYPE, LIVE.tableArn));
    assert.equal(table.kind === 'failed' && table.reason.code, 'INTERNAL_SERVER_ERROR');
    for (const entry of [
      tagIndexEntry('AWS::ResourceGroupsTaggingAPI::TaggedResource', 'arn:aws:s3:::bucket'),
      tagIndexEntry(QUEUE_RESOURCE_TYPE, 'not-a-queue-id'),
    ]) {
      assert.deepEqual(await surfaces.confirmPresence(entry), { kind: 'present' }, entry.identifier);
    }
  });
});
