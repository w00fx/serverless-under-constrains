// The ownership context cleanup proves ownership against (BR-RUA-050): built from a resource
// manifest of this execution with exactly one run tag (the execution id) and one study tag.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ownershipContextFromManifest, STUDY_BASELINE_EXCLUSIONS } from '../../../src/cleanup/ownership-context.ts';
import { resourceKey } from '../../../src/cleanup/resource-names.ts';
import type { ExecutionIdentity } from '../../../src/record-contract/primitives.ts';
import type { ResourceManifest } from '../../../src/record-contract/records/group-a/resource_manifest.ts';
import {
  EXECUTION,
  EXECUTION_FROZEN_AT,
  EXECUTION_ID,
  NAMES,
  OTHER_EXECUTION_ID,
  resourceManifest,
  runTags,
  STACK_ID,
  STACK_MEMBERS,
  STACK_NAME,
  STUDY_ID,
} from '../../support/cleanup/cleanup-fixtures.ts';

function contextOf(
  manifest: ResourceManifest,
  execution: ExecutionIdentity = EXECUTION,
): ReturnType<typeof ownershipContextFromManifest> {
  return ownershipContextFromManifest({
    manifest,
    execution,
    execution_manifest_frozen_at: EXECUTION_FROZEN_AT,
    baseline: STUDY_BASELINE_EXCLUSIONS,
  });
}

function refusal(result: ReturnType<typeof ownershipContextFromManifest>): string {
  assert.ok(!result.ok, 'expected a refusal');
  assert.equal(result.error.code, 'OWNERSHIP_CONTEXT_INVALID');
  return result.error.detail;
}

describe('ownershipContextFromManifest', () => {
  it('builds the context of a succeeded manifest', () => {
    const result = contextOf(resourceManifest());
    assert.ok(result.ok);
    const context = result.value;
    assert.equal(context.execution_id, EXECUTION_ID);
    assert.equal(context.study_id, STUDY_ID);
    assert.equal(context.recorded_stack_id, STACK_ID);
    assert.equal(context.provisioning_status, 'succeeded');
    assert.deepEqual(context.run_tags, runTags());
    assert.deepEqual(
      [...context.manifest_members],
      STACK_MEMBERS.map((member) => resourceKey(member)),
    );
    assert.deepEqual(context.deterministic_names, [STACK_NAME]);
    assert.deepEqual(context.deterministic_name_prefixes, ['suc1-aaaaaaaa-', `/suc/study-1/${EXECUTION_ID}/`]);
    assert.ok(context.expected_resource_types.has('AWS::IAM::Policy'));
    assert.equal(context.execution_manifest_frozen_at, EXECUTION_FROZEN_AT);
    assert.equal(context.baseline, STUDY_BASELINE_EXCLUSIONS);
  });

  it('leaves out the stack id of a partial manifest without one, and members without a physical id', () => {
    const manifest = resourceManifest('partial', { withStack: false });
    const withoutPhysical: ResourceManifest = {
      ...manifest,
      resources: [
        ...manifest.resources,
        { logical_id: 'Pending', resource_type: 'AWS::SQS::Queue', resource_status: 'CREATE_IN_PROGRESS' },
      ],
    };
    const result = contextOf(withoutPhysical);
    assert.ok(result.ok);
    assert.equal('recorded_stack_id' in result.value, false);
    assert.equal(result.value.manifest_members.size, STACK_MEMBERS.length);
  });

  it('refuses a manifest of another execution, for every identity kind', () => {
    assert.match(
      refusal(contextOf(resourceManifest(), { execution_kind: 'RUN', run_id: OTHER_EXECUTION_ID })),
      /resource manifest of execution aaaaaaaa/,
    );
    const probeManifest = resourceManifest('succeeded', { identity: { transport_probe_id: OTHER_EXECUTION_ID } });
    assert.match(
      refusal(contextOf(probeManifest)),
      new RegExp(`of execution ${OTHER_EXECUTION_ID}; expected execution ${EXECUTION_ID}`),
    );
    const validationManifest = resourceManifest('succeeded', {
      identity: { variant_validation_id: OTHER_EXECUTION_ID },
    });
    assert.match(refusal(contextOf(validationManifest)), new RegExp(`of execution ${OTHER_EXECUTION_ID}`));
  });

  it('accepts a variant validation manifest of its own execution', () => {
    const manifest = resourceManifest('succeeded', { identity: { variant_validation_id: EXECUTION_ID } });
    const result = contextOf(manifest, { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: EXECUTION_ID });
    assert.ok(result.ok);
  });

  it('refuses a run tag that is absent, repeated or of another execution', () => {
    const others = runTags().filter((tag) => tag.key !== 'suc:run_id');
    assert.match(
      refusal(contextOf(resourceManifest('succeeded', { tags: others }))),
      /suc:run_id tag absent; expected exactly one tag/,
    );
    assert.match(
      refusal(
        contextOf(resourceManifest('succeeded', { tags: [...runTags(), { key: 'suc:run_id', value: EXECUTION_ID }] })),
      ),
      /suc:run_id tag absent/,
    );
    assert.match(
      refusal(contextOf(resourceManifest('succeeded', { tags: runTags(OTHER_EXECUTION_ID) }))),
      new RegExp(`"${OTHER_EXECUTION_ID}"`),
    );
  });

  it('refuses a study tag that is absent or repeated', () => {
    const withoutStudy = runTags().filter((tag) => tag.key !== 'suc:study_id');
    assert.match(
      refusal(contextOf(resourceManifest('succeeded', { tags: withoutStudy }))),
      /suc:study_id tag absent or repeated/,
    );
    const repeated = [...runTags(), { key: 'suc:study_id' as const, value: 'study-2' }];
    assert.match(refusal(contextOf(resourceManifest('succeeded', { tags: repeated }))), /suc:study_id/);
  });

  it('names the deterministic prefixes after the execution id', () => {
    const result = contextOf(resourceManifest());
    assert.ok(result.ok);
    assert.ok(NAMES.controlTable.startsWith(result.value.deterministic_name_prefixes[0] ?? '?'));
  });
});
