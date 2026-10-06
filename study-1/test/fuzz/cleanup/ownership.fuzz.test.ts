// Property targets `proveOwnership` and `judgeOwnership` (BR-RUA-050, design §8.18): discovered
// resources are untrusted observations of the account, so over any mix of types, names, tags,
// creation times, stack links and manifest states the rules must hold in both directions:
// - a baseline or bootstrap name is always excluded, whatever else it carries;
// - each owned basis implies exactly the evidence its rule names, and only the recorded stack
//   may own a resource without run-specific tags (the generic project tag never counts);
// - an ambiguous decision always says why, in schema-conforming reasons;
// - per resource, `judgeOwnership` keeps the strongest decision any sighting reached.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { DiscoveredResource, ResourceTag, TagObservation } from '../../../src/cleanup/discovery.ts';
import type { OwnershipContext } from '../../../src/cleanup/ownership-context.ts';
import { RUN_ID_TAG, STUDY_ID_TAG } from '../../../src/cleanup/ownership-context.ts';
import type { OwnershipDecision } from '../../../src/cleanup/ownership.ts';
import { isDirectlyDeletable, proveOwnership } from '../../../src/cleanup/ownership.ts';
import { judgeOwnership } from '../../../src/cleanup/ownership-judgement.ts';
import { canonicalResourceName, resourceKey } from '../../../src/cleanup/resource-names.ts';
import { STACK_RESOURCE_TYPE } from '../../../src/cleanup/resource-types.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import { LEAK_AUDIT_SURFACES } from '../../../src/record-contract/records/group-c/vocabulary.ts';
import {
  AFTER_FREEZE,
  BEFORE_FREEZE,
  EXECUTION_FROZEN_AT,
  OTHER_EXECUTION_ID,
  ownershipContext,
  resourceManifest,
  runTags,
  STACK_ID,
  STACK_MEMBERS,
  STACK_NAME,
} from '../../support/cleanup/cleanup-fixtures.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const UPPER_SNAKE = /^[A-Z][A-Z0-9_]*$/;

const contexts: readonly OwnershipContext[] = [
  ownershipContext(),
  ownershipContext(resourceManifest('partial', { members: STACK_MEMBERS.slice(0, 3) })),
  ownershipContext(resourceManifest('partial', { members: [], withStack: false })),
  ownershipContext(resourceManifest('failed', { members: STACK_MEMBERS.slice(3) })),
];

const typedIdentity = fc.oneof(
  fc.constantFrom(
    ...STACK_MEMBERS.map((member) => ({ resource_type: member.resource_type, identifier: member.identifier })),
  ),
  fc.constantFrom(
    { resource_type: STACK_RESOURCE_TYPE, identifier: STACK_ID },
    { resource_type: STACK_RESOURCE_TYPE, identifier: 'suc-study-1-coordination' },
    { resource_type: STACK_RESOURCE_TYPE, identifier: 'CDKToolkit' },
    { resource_type: 'AWS::S3::Bucket', identifier: 'cdk-hnb659fds-assets-123456789012-us-east-1' },
    { resource_type: 'AWS::IAM::Role', identifier: 'cdk-hnb659fds-deploy-role' },
    { resource_type: STACK_RESOURCE_TYPE, identifier: STACK_NAME },
  ),
  fc.record({
    resource_type: fc.constantFrom(
      ...STACK_MEMBERS.map((member) => member.resource_type),
      'AWS::SNS::Topic',
      'Custom::Thing',
    ),
    identifier: fc.string({ minLength: 1, maxLength: 30 }),
  }),
);

// Tags drawn from the run tags, another run's tags, duplicates and arbitrary pairs.
const tagPool: readonly ResourceTag[] = [...runTags(), ...runTags(OTHER_EXECUTION_ID)];
const tagList = fc.array(
  fc.oneof(
    fc.constantFrom(...tagPool),
    fc.record({ key: fc.string({ maxLength: 12 }), value: fc.string({ maxLength: 12 }) }),
  ),
  { maxLength: 8 },
);
const tagObservation: fc.Arbitrary<TagObservation> = fc.oneof(
  tagList.map((tags) => ({ kind: 'tagged' as const, tags })),
  fc.constant({ kind: 'untaggable' as const }),
  fc.constant({ kind: 'unknown' as const, reason: { code: 'TAGS_UNREADABLE', subject: 'tags', detail: 'denied' } }),
);

const resource: fc.Arbitrary<DiscoveredResource> = fc
  .record(
    {
      identity: typedIdentity,
      surface: fc.constantFrom(...LEAK_AUDIT_SURFACES),
      tags: tagObservation,
      created_at: fc.constantFrom<UtcMillis>(AFTER_FREEZE, BEFORE_FREEZE, EXECUTION_FROZEN_AT),
      managed_by_stack_id: fc.constantFrom(STACK_ID, 'arn:aws:cloudformation:us-east-1:1:stack/other/x'),
    },
    { requiredKeys: ['identity', 'surface', 'tags'] },
  )
  .map(({ identity, ...rest }) => ({ ...identity, ...rest }));

function singleValue(found: DiscoveredResource, key: string): string | undefined {
  if (found.tags.kind !== 'tagged') {
    return undefined;
  }
  const matching = found.tags.tags.filter((tag) => tag.key === key);
  return matching.length === 1 ? matching[0]?.value : undefined;
}

function carriesRunTags(found: DiscoveredResource, context: OwnershipContext): boolean {
  return (
    singleValue(found, RUN_ID_TAG) === context.execution_id && singleValue(found, STUDY_ID_TAG) === context.study_id
  );
}

function isBaselineName(found: DiscoveredResource, context: OwnershipContext): boolean {
  const name = canonicalResourceName(found.resource_type, found.identifier);
  return (
    context.baseline.names.includes(name) || context.baseline.name_prefixes.some((prefix) => name.startsWith(prefix))
  );
}

function assertBasisEvidence(found: DiscoveredResource, context: OwnershipContext, decision: OwnershipDecision): void {
  if (decision.kind !== 'owned') {
    return;
  }
  const member = context.manifest_members.has(resourceKey(found));
  switch (decision.basis) {
    case 'resource_manifest_and_tags':
      assert.ok(member && carriesRunTags(found, context), 'manifest basis without membership and run tags');
      return;
    case 'tags_name_type_created_after_freeze':
      assert.ok(!member && context.provisioning_status !== 'succeeded', 'partial-manifest basis on a recorded member');
      assert.ok(
        context.run_tags.every((tag) => singleValue(found, tag.key) === tag.value),
        'without every run tag',
      );
      assert.ok((found.created_at ?? '') > context.execution_manifest_frozen_at, 'created before the freeze');
      return;
    case 'recorded_stack':
      assert.ok(context.recorded_stack_id !== undefined, 'stack basis without a recorded stack');
      return;
  }
}

describe('proveOwnership properties', () => {
  it('excludes baselines, proves each basis by its evidence and explains ambiguity', () => {
    fc.assert(
      fc.property(fc.constantFrom(...contexts), resource, (context, found) => {
        const decision = proveOwnership(found, context);
        assert.equal(decision.kind === 'excluded_baseline', isBaselineName(found, context));
        assertBasisEvidence(found, context, decision);
        if (decision.kind === 'ambiguous') {
          assert.ok(decision.reasons.length >= 1);
          assert.ok(decision.reasons.every((reason) => UPPER_SNAKE.test(reason.code) && reason.detail.length > 0));
          assert.ok(decision.reasons.every((reason) => reason.subject === 'BR-RUA-050'));
        }
      }),
      fuzzParameters(),
    );
  });

  it('never owns a resource by its generic project tag alone', () => {
    const projectOnly = resource.map(({ managed_by_stack_id: _unlinked, ...found }) => ({
      ...found,
      tags: { kind: 'tagged' as const, tags: runTags().filter((tag) => tag.key === 'suc:project') },
    }));
    fc.assert(
      fc.property(fc.constantFrom(...contexts), projectOnly, (context, found) => {
        const decision = proveOwnership(found, context);
        const stackBoundary = decision.kind === 'owned' && decision.basis === 'recorded_stack';
        assert.ok(decision.kind !== 'owned' || stackBoundary, `owned on ${JSON.stringify(decision)}`);
      }),
      fuzzParameters(),
    );
  });
});

function rank(decision: OwnershipDecision): number {
  if (decision.kind === 'excluded_baseline') {
    return 0;
  }
  if (decision.kind === 'owned') {
    return isDirectlyDeletable(decision.basis) ? 1 : 2;
  }
  return 3;
}

describe('judgeOwnership properties', () => {
  it('keeps one decision per resource, the strongest any sighting reached', () => {
    fc.assert(
      fc.property(fc.constantFrom(...contexts), fc.array(resource, { maxLength: 12 }), (context, sightings) => {
        const judged = judgeOwnership(sightings, context);
        assert.deepEqual([...judged.keys()], [...new Set(sightings.map((found) => resourceKey(found)))]);
        for (const [key, kept] of judged) {
          const ranks = sightings
            .filter((found) => resourceKey(found) === key)
            .map((found) => rank(proveOwnership(found, context)));
          assert.equal(rank(kept.decision), Math.min(...ranks));
          assert.deepEqual(kept.decision, proveOwnership(kept.resource, context));
        }
      }),
      fuzzParameters(),
    );
  });
});
