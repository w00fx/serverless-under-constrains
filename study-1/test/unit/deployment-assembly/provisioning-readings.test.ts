// What provisioning reads back after deployment (design §9.8 D4; BR-RUA-040, BR-RUA-053): each
// entry is held to the resource-manifest shapes, malformed or repeated entries are left out with a
// reason, incomplete resources are kept with one, configuration is canonical and unique per
// attribute, and the provider version is the number at the end of its version ARN.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkConfiguration,
  checkOutputs,
  checkStackResources,
  COMPLETE_RESOURCE_STATUSES,
  providerVersionNumber,
} from '../../../src/deployment-assembly/provisioning-readings.ts';
import type { StackResourceSummary } from '../../../src/deployment-assembly/provisioning-readings.ts';

const VERSION_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:suc1-3f1c2a9e-provider:7';

function resource(logicalId: string, overrides: Partial<StackResourceSummary> = {}): StackResourceSummary {
  return {
    logical_id: logicalId,
    resource_type: 'AWS::SQS::Queue',
    physical_id: `p-${logicalId}`,
    resource_status: 'CREATE_COMPLETE',
    ...overrides,
  };
}

function codes(reasons: readonly { readonly code: string }[]): readonly string[] {
  return reasons.map((reason) => reason.code);
}

describe('checkStackResources', () => {
  it('keeps well-formed resources sorted by logical id', () => {
    const checked = checkStackResources([
      resource('Zeta'),
      { logical_id: 'Alpha', resource_type: 'AWS::SQS::Queue', resource_status: 'UPDATE_COMPLETE' },
    ]);
    assert.deepEqual(checked, {
      entries: [
        { logical_id: 'Alpha', resource_type: 'AWS::SQS::Queue', resource_status: 'UPDATE_COMPLETE' },
        {
          logical_id: 'Zeta',
          resource_type: 'AWS::SQS::Queue',
          physical_id: 'p-Zeta',
          resource_status: 'CREATE_COMPLETE',
        },
      ],
      reasons: [],
    });
    assert.deepEqual(COMPLETE_RESOURCE_STATUSES, ['CREATE_COMPLETE', 'UPDATE_COMPLETE']);
  });

  it('keeps an incomplete resource with a reason', () => {
    const checked = checkStackResources([resource('Queue', { resource_status: 'CREATE_FAILED' })]);
    assert.equal(checked.entries.length, 1);
    assert.deepEqual(codes(checked.reasons), ['RESOURCE_NOT_COMPLETE']);
    assert.equal(
      checked.reasons[0]?.detail,
      'resource Queue is CREATE_FAILED; expected CREATE_COMPLETE or UPDATE_COMPLETE',
    );
  });

  it('leaves out malformed and repeated entries with a reason each', () => {
    const malformed = [
      resource('bad-id'),
      resource('Type', { resource_type: 'Custom::Thing' }),
      resource('Status', { resource_status: 'create_complete' }),
      resource('Empty', { physical_id: '' }),
    ];
    const checked = checkStackResources([...malformed, resource('Twice'), resource('Twice', { physical_id: 'other' })]);
    assert.deepEqual(
      checked.entries.map((entry) => [entry.logical_id, entry.physical_id]),
      [['Twice', 'p-Twice']],
    );
    assert.deepEqual(codes(checked.reasons), Array<string>(5).fill('RESOURCE_ENTRY_INVALID'));
    assert.match(checked.reasons[4]?.detail ?? '', /^resource "Twice" .* is repeated;/);
    assert.match(checked.reasons[0]?.detail ?? '', /^resource "bad-id" .* is malformed;/);
  });
});

describe('checkConfiguration', () => {
  it('stores canonical JSON per attribute, sorted by logical id then path, once per attribute', () => {
    const checked = checkConfiguration([
      { logical_id: 'Queue', attribute_path: 'VisibilityTimeout', value: 360 },
      { logical_id: 'Mapping', attribute_path: 'ScalingConfig', value: { b: 1, a: [true, null] } },
      { logical_id: 'Mapping', attribute_path: 'BatchSize', value: 1 },
      { logical_id: 'Mapping', attribute_path: 'BatchSize', value: 1 },
    ]);
    assert.deepEqual(checked, {
      entries: [
        { logical_id: 'Mapping', attribute_path: 'BatchSize', canonical_json: '1' },
        { logical_id: 'Mapping', attribute_path: 'ScalingConfig', canonical_json: '{"a":[true,null],"b":1}' },
        { logical_id: 'Queue', attribute_path: 'VisibilityTimeout', canonical_json: '360' },
      ],
      reasons: [],
    });
  });

  it('sorts by logical id before attribute path even when a path sorts before the separator', () => {
    const checked = checkConfiguration([
      { logical_id: 'AB', attribute_path: 'X', value: 1 },
      { logical_id: 'A', attribute_path: 'Z', value: 2 },
    ]);
    assert.deepEqual(
      checked.entries.map((entry) => entry.logical_id),
      ['A', 'AB'],
    );
  });

  it('refuses a conflicting second reading, a misnamed one and a value JSON cannot represent', () => {
    const checked = checkConfiguration([
      { logical_id: 'Mapping', attribute_path: 'BatchSize', value: 1 },
      { logical_id: 'Mapping', attribute_path: 'BatchSize', value: 10 },
      { logical_id: 'Bad-Id', attribute_path: 'BatchSize', value: 1 },
      { logical_id: 'Mapping', attribute_path: 'Batch..Size', value: 1 },
      { logical_id: 'Mapping', attribute_path: 'Timeout', value: Number.NaN },
    ]);
    assert.deepEqual(
      checked.entries.map((entry) => entry.canonical_json),
      ['1'],
    );
    assert.deepEqual(codes(checked.reasons), [
      'CONFIGURATION_CONFLICT',
      'CONFIGURATION_ENTRY_INVALID',
      'CONFIGURATION_ENTRY_INVALID',
      'CONFIGURATION_ENTRY_INVALID',
    ]);
    assert.match(checked.reasons[0]?.detail ?? '', /was read as "1" and "10"; expected one value$/);
    assert.match(checked.reasons[1]?.detail ?? '', /is misnamed;/);
    assert.match(checked.reasons[3]?.detail ?? '', /is not representable as JSON;/);
  });
});

describe('checkOutputs', () => {
  it('keeps one entry per key in the given order and refuses malformed or repeated keys', () => {
    const checked = checkOutputs([
      { key: 'ProviderVersion', value: '7' },
      { key: 'Bad-Key', value: 'x' },
      { key: 'ProviderVersion', value: '8' },
      { key: 'AliasArn', value: 'arn' },
    ]);
    assert.deepEqual(checked.entries, [
      { key: 'ProviderVersion', value: '7' },
      { key: 'AliasArn', value: 'arn' },
    ]);
    assert.deepEqual(codes(checked.reasons), ['OUTPUT_INVALID', 'OUTPUT_INVALID']);
  });
});

describe('providerVersionNumber (BR-RUA-053)', () => {
  const version = {
    logical_id: 'ProviderVersion1',
    resource_type: 'AWS::Lambda::Version',
    physical_id: VERSION_ARN,
    resource_status: 'CREATE_COMPLETE',
  };

  it('reads the number at the end of the version ARN', () => {
    assert.deepEqual(providerVersionNumber([version], 'ProviderVersion1'), { version: '7', reasons: [] });
  });

  it('is unknown when the version is not listed, not a Lambda version, or its ARN has no number', () => {
    const cases = [
      { resources: [], shown: 'not listed' },
      {
        resources: [{ ...version, resource_type: 'AWS::Lambda::Alias' }],
        shown: `AWS::Lambda::Alias "${VERSION_ARN}"`,
      },
      {
        resources: [{ ...version, physical_id: VERSION_ARN.replace(':7', ':$LATEST') }],
        shown: 'AWS::Lambda::Version',
      },
      { resources: [{ ...version, physical_id: VERSION_ARN.replace(':7', ':0') }], shown: 'AWS::Lambda::Version' },
      {
        resources: [
          { logical_id: 'ProviderVersion1', resource_type: 'AWS::Lambda::Version', resource_status: 'CREATE_COMPLETE' },
        ],
        shown: 'AWS::Lambda::Version ""',
      },
    ];
    for (const { resources, shown } of cases) {
      const result = providerVersionNumber(resources, 'ProviderVersion1');
      assert.equal(result.version, undefined);
      assert.deepEqual(
        result.reasons.map((reason) => [reason.code, reason.subject]),
        [['PROVIDER_VERSION_UNKNOWN', 'BR-RUA-053']],
      );
      assert.ok(result.reasons[0]?.detail.includes(`is ${shown}`), `${result.reasons[0]?.detail ?? ''} lacks ${shown}`);
    }
  });
});
