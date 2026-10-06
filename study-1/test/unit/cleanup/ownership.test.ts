// BR-RUA-050 conservative ownership, rule by rule (design §8.18): baseline exclusion, the
// recorded stack boundary, manifest membership with run-specific tags, the partial-manifest rule
// (exact run tags, expected type or deterministic name, creation after the freeze), and
// everything else ambiguous with every failed condition as a reason.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DiscoveredResource } from '../../../src/cleanup/discovery.ts';
import type { OwnershipDecision } from '../../../src/cleanup/ownership.ts';
import { isDirectlyDeletable, proveOwnership } from '../../../src/cleanup/ownership.ts';
import {
  DURABLE_EXECUTION_RESOURCE_TYPE,
  FUNCTION_RESOURCE_TYPE,
  LOG_GROUP_RESOURCE_TYPE,
  QUEUE_RESOURCE_TYPE,
  STACK_RESOURCE_TYPE,
  TABLE_RESOURCE_TYPE,
} from '../../../src/cleanup/resource-types.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import {
  BEFORE_FREEZE,
  discovered,
  EXECUTION_FROZEN_AT,
  EXECUTION_ID,
  NAMES,
  OTHER_EXECUTION_ID,
  ownershipContext,
  resourceManifest,
  runTags,
  STACK_ID,
  STACK_LISTING_TAGS,
  STACK_MEMBERS,
  STACK_NAME,
  tagged,
} from '../../support/cleanup/cleanup-fixtures.ts';

const SUCCEEDED = ownershipContext();
const PARTIAL = ownershipContext(resourceManifest('partial', { members: STACK_MEMBERS.slice(0, 1) }));
const PARTIAL_WITHOUT_STACK = ownershipContext(resourceManifest('partial', { members: [], withStack: false }));
const TABLE = discovered(TABLE_RESOURCE_TYPE, NAMES.controlTable, 'tables');

function reasonCodes(decision: OwnershipDecision): readonly string[] {
  assert.equal(decision.kind, 'ambiguous', `decision ${JSON.stringify(decision)}`);
  return decision.reasons.map((reason) => reason.code);
}

describe('proveOwnership: baseline and the recorded stack', () => {
  it('excludes baseline resources by name and by name prefix, whatever their tags', () => {
    const coordination = discovered(STACK_RESOURCE_TYPE, 'suc-study-1-coordination', 'stack');
    const bootstrapRole = discovered('AWS::IAM::Role', 'cdk-hnb659fds-deploy-role-123456789012-us-east-1', 'roles');
    const toolkit = discovered(STACK_RESOURCE_TYPE, 'arn:aws:cloudformation:us-east-1:1:stack/CDKToolkit/abc', 'stack');
    for (const resource of [coordination, bootstrapRole, toolkit]) {
      assert.deepEqual(proveOwnership(resource, SUCCEEDED), { kind: 'excluded_baseline' });
    }
  });

  it('owns the recorded stack by its id only', () => {
    assert.deepEqual(proveOwnership(discovered(STACK_RESOURCE_TYPE, STACK_ID, 'stack'), SUCCEEDED), {
      kind: 'owned',
      basis: 'recorded_stack',
    });
    const sameNameOtherId = discovered(STACK_RESOURCE_TYPE, STACK_ID.replace('0f0e0d0c', '99999999'), 'stack', {
      created_at: BEFORE_FREEZE,
    });
    assert.deepEqual(reasonCodes(proveOwnership(sameNameOtherId, SUCCEEDED)), [
      'NOT_IN_COMPLETE_MANIFEST',
      'CREATED_BEFORE_MANIFEST_FREEZE',
    ]);
  });
});

describe('proveOwnership: manifest members', () => {
  it('owns a member with the run-specific tags for direct deletion', () => {
    assert.deepEqual(proveOwnership(TABLE, SUCCEEDED), { kind: 'owned', basis: 'resource_manifest_and_tags' });
  });

  it('matches a member by canonical name: a queue listed by URL or by name', () => {
    const byName = discovered(QUEUE_RESOURCE_TYPE, 'suc1-aaaaaaaa-durable-dlq.fifo', 'tag_index');
    assert.deepEqual(proveOwnership(byName, SUCCEEDED), { kind: 'owned', basis: 'resource_manifest_and_tags' });
  });

  it('owns a member without readable run tags only through the recorded stack', () => {
    const listed = discovered(TABLE_RESOURCE_TYPE, NAMES.controlTable, 'stack_resources', {
      tags: STACK_LISTING_TAGS,
      managed_by_stack_id: STACK_ID,
    });
    assert.deepEqual(proveOwnership(listed, SUCCEEDED), { kind: 'owned', basis: 'recorded_stack' });
    const untaggable = discovered(TABLE_RESOURCE_TYPE, NAMES.controlTable, 'tables', { tags: { kind: 'untaggable' } });
    assert.deepEqual(proveOwnership(untaggable, SUCCEEDED), { kind: 'owned', basis: 'recorded_stack' });
  });

  it('leaves a member with other tags and no stack evidence ambiguous', () => {
    const otherRun = discovered(TABLE_RESOURCE_TYPE, NAMES.controlTable, 'tables', {
      tags: tagged(runTags(OTHER_EXECUTION_ID)),
    });
    const decision = proveOwnership(otherRun, SUCCEEDED);
    assert.deepEqual(reasonCodes(decision), ['RUN_TAGS_NOT_PROVEN']);
    assert.match(JSON.stringify(decision), /expected to carry suc:run_id and suc:study_id/);
    const unknownTags = discovered(TABLE_RESOURCE_TYPE, NAMES.controlTable, 'tables', { tags: STACK_LISTING_TAGS });
    assert.match(JSON.stringify(proveOwnership(unknownTags, SUCCEEDED)), /tags unreadable \(TAGS_NOT_LISTED\)/);
  });

  it('never uses the stack boundary when no stack is recorded', () => {
    const context = ownershipContext(resourceManifest('partial', { withStack: false }));
    const untaggable = discovered(TABLE_RESOURCE_TYPE, NAMES.controlTable, 'tables', {
      tags: { kind: 'untaggable' },
      managed_by_stack_id: STACK_ID,
    });
    const decision = proveOwnership(untaggable, context);
    assert.deepEqual(reasonCodes(decision), ['RUN_TAGS_NOT_PROVEN']);
    assert.match(JSON.stringify(decision), /tags unsupported by its type/);
  });

  it('rejects a repeated run tag even when one copy matches', () => {
    const repeated = discovered(TABLE_RESOURCE_TYPE, NAMES.controlTable, 'tables', {
      tags: tagged([...runTags(), { key: 'suc:run_id', value: OTHER_EXECUTION_ID }]),
    });
    assert.deepEqual(reasonCodes(proveOwnership(repeated, SUCCEEDED)), ['RUN_TAGS_NOT_PROVEN']);
  });
});

describe('proveOwnership: resources outside the manifest', () => {
  const orphan = discovered(LOG_GROUP_RESOURCE_TYPE, `/aws/lambda/${NAMES.providerFunction}`, 'log_groups');

  it('owns an orphan of a partial manifest with exact run tags, expected type and a later creation', () => {
    assert.deepEqual(proveOwnership(orphan, PARTIAL), { kind: 'owned', basis: 'tags_name_type_created_after_freeze' });
    assert.ok(isDirectlyDeletable('tags_name_type_created_after_freeze'));
  });

  it('accepts a deterministic name or prefix in place of an expected type', () => {
    const bucket = discovered('AWS::S3::Bucket', `${NAMES.providerFunction}-artifacts`, 'tag_index');
    assert.deepEqual(proveOwnership(bucket, PARTIAL), { kind: 'owned', basis: 'tags_name_type_created_after_freeze' });
    const nestedStack = discovered('AWS::CloudFormation::StackSet', STACK_NAME, 'tag_index');
    assert.deepEqual(proveOwnership(nestedStack, PARTIAL), {
      kind: 'owned',
      basis: 'tags_name_type_created_after_freeze',
    });
    const underRunPrefix = discovered('AWS::Custom::Thing', `/suc/study-1/${EXECUTION_ID}/custom`, 'tag_index');
    assert.deepEqual(proveOwnership(underRunPrefix, PARTIAL), {
      kind: 'owned',
      basis: 'tags_name_type_created_after_freeze',
    });
    const otherPrefix = discovered('AWS::Custom::Thing', '/suc/study-1/other/custom', 'tag_index');
    assert.deepEqual(reasonCodes(proveOwnership(otherPrefix, PARTIAL)), ['UNEXPECTED_TYPE_AND_NAME']);
  });

  it('lists every failed condition, in rule order', () => {
    const stray = discovered('AWS::S3::Bucket', 'unrelated-bucket', 'tag_index', {
      tags: tagged([{ key: 'suc:project', value: 'serverless-under-constraints' }]),
      created_at: BEFORE_FREEZE,
    });
    assert.deepEqual(reasonCodes(proveOwnership(stray, SUCCEEDED)), [
      'NOT_IN_COMPLETE_MANIFEST',
      'RUN_TAGS_NOT_PROVEN',
      'UNEXPECTED_TYPE_AND_NAME',
      'CREATED_BEFORE_MANIFEST_FREEZE',
    ]);
  });

  it('never owns a resource that carries only the generic project tag', () => {
    const projectOnly = discovered(FUNCTION_RESOURCE_TYPE, `${NAMES.providerFunction}-x`, 'functions', {
      tags: tagged([{ key: 'suc:project', value: 'serverless-under-constraints' }]),
    });
    assert.deepEqual(reasonCodes(proveOwnership(projectOnly, PARTIAL)), ['RUN_TAGS_NOT_PROVEN']);
  });

  it('needs a creation strictly after the execution manifest froze', () => {
    const { created_at: _dropped, ...withoutCreation }: DiscoveredResource = orphan;
    assert.deepEqual(reasonCodes(proveOwnership(withoutCreation, PARTIAL)), ['CREATION_TIME_UNKNOWN']);
    const atFreeze = { ...orphan, created_at: EXECUTION_FROZEN_AT };
    assert.deepEqual(reasonCodes(proveOwnership(atFreeze, PARTIAL)), ['CREATED_BEFORE_MANIFEST_FREEZE']);
    const justAfter = { ...orphan, created_at: '2026-10-05T11:00:00.001Z' as UtcMillis };
    assert.equal(proveOwnership(justAfter, PARTIAL).kind, 'owned');
  });

  it('falls back to the stack boundary for a resource the recorded stack lists', () => {
    const execution = discovered(DURABLE_EXECUTION_RESOURCE_TYPE, 'arn:durable/1', 'durable_executions', {
      tags: { kind: 'untaggable' },
      managed_by_stack_id: STACK_ID,
    });
    assert.deepEqual(proveOwnership(execution, SUCCEEDED), { kind: 'owned', basis: 'recorded_stack' });
    assert.equal(isDirectlyDeletable('recorded_stack'), false);
    const otherStack = { ...execution, managed_by_stack_id: 'arn:other' };
    assert.equal(proveOwnership(otherStack, SUCCEEDED).kind, 'ambiguous');
    assert.equal(proveOwnership(execution, PARTIAL_WITHOUT_STACK).kind, 'ambiguous');
  });
});
