// D-30 capability classes of leaked resources (BR-RUA-052, AC-RUA-050 input): the class follows
// the resource type alone, and only processing-capable or unknown leaks compromise isolation.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyLeakCapability, leakCompromisesIsolation } from '../../../src/cleanup/leak-capability.ts';
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
} from '../../../src/cleanup/resource-types.ts';
import { LEAK_CAPABILITY_CLASSES } from '../../../src/record-contract/records/group-c/vocabulary.ts';

describe('classifyLeakCapability', () => {
  const cases: readonly (readonly [string, string])[] = [
    [STACK_RESOURCE_TYPE, 'processing_capable'],
    [FUNCTION_RESOURCE_TYPE, 'processing_capable'],
    [FUNCTION_VERSION_RESOURCE_TYPE, 'processing_capable'],
    [FUNCTION_ALIAS_RESOURCE_TYPE, 'processing_capable'],
    [EVENT_SOURCE_MAPPING_RESOURCE_TYPE, 'processing_capable'],
    [DURABLE_EXECUTION_RESOURCE_TYPE, 'processing_capable'],
    [QUEUE_RESOURCE_TYPE, 'storage_only'],
    [TABLE_RESOURCE_TYPE, 'storage_only'],
    [LOG_GROUP_RESOURCE_TYPE, 'storage_only'],
    [ROLE_RESOURCE_TYPE, 'identity'],
    ['AWS::IAM::Policy', 'identity'],
    ['AWS::IAM::ManagedPolicy', 'identity'],
    ['AWS::Lambda::Permission', 'identity'],
    ['AWS::SQS::QueuePolicy', 'identity'],
    ['AWS::S3::Bucket', 'unknown'],
    ['', 'unknown'],
  ];
  for (const [type, expected] of cases) {
    it(`classifies ${type === '' ? 'an empty type' : type} as ${expected}`, () => {
      assert.equal(classifyLeakCapability({ resource_type: type }), expected);
    });
  }

  it('does not read inherited member names as types', () => {
    assert.equal(classifyLeakCapability({ resource_type: 'constructor' }), 'unknown');
    assert.equal(classifyLeakCapability({ resource_type: '__proto__' }), 'unknown');
  });
});

describe('leakCompromisesIsolation', () => {
  it('is true exactly for processing_capable and unknown leaks', () => {
    const verdicts = Object.fromEntries(
      LEAK_CAPABILITY_CLASSES.map((capability) => [
        capability,
        leakCompromisesIsolation({ capability_class: capability }),
      ]),
    );
    assert.deepEqual(verdicts, { processing_capable: true, storage_only: false, identity: false, unknown: true });
  });
});
