// Normalization strips execution identity (names, tags, ARNs, ids, logical ids) and keeps
// configuration (BR-RUA-028, BR-RUA-050 names and tags). Includes a property test over
// generated values: normalization is total and idempotent.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import {
  STRIPPED_PROPERTY_KEYS,
  normalizeCfnString,
  normalizeCfnValue,
} from '../../../../src/transport-qualification/scope/cfn-value-normalization.ts';
import { fuzzParameters } from '../../../support/kernel/fuzz-parameters.ts';

function hasObjectKey(value: JsonValue, key: string): boolean {
  if (Array.isArray(value)) {
    return (value as readonly JsonValue[]).some((item) => hasObjectKey(item, key));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(([name, inner]) => name === key || hasObjectKey(inner, key));
  }
  return false;
}

const TYPES = new Map([
  ['LedgerA1B2', 'AWS::DynamoDB::Table'],
  ['QueueC3D4', 'AWS::SQS::Queue'],
]);

describe('normalizeCfnString', () => {
  it('replaces an ARN as a whole', () => {
    assert.equal(normalizeCfnString('arn:aws:sqs:us-east-1:123456789012:suc1-3f1c2a9e-x'), '<arn>');
  });

  it('replaces every UUID, in either case', () => {
    assert.equal(
      normalizeCfnString('/suc/study-1/3f1c2a9e-8b4d-4c1e-9f00-1a2b3c4d5e6f/a/3F1C2A9E-8B4D-4C1E-9F00-1A2B3C4D5E6F'),
      '/suc/study-1/<uuid>/a/<uuid>',
    );
  });

  it('replaces every execution prefix of run-owned names and stack names', () => {
    assert.equal(normalizeCfnString('suc1-3f1c2a9e-ledger,suc1-0000beef-control'), 'suc1-<p>-ledger,suc1-<p>-control');
    assert.equal(normalizeCfnString('SucRua-probe-3f1c2a9e/SucRua-run-0000beef'), 'SucRua-probe-<p>/SucRua-run-<p>');
    assert.equal(normalizeCfnString('SucRua-validation-0123abcd'), 'SucRua-validation-<p>');
  });

  it('keeps configuration strings and near misses', () => {
    assert.equal(normalizeCfnString('nodejs24.x'), 'nodejs24.x');
    assert.equal(normalizeCfnString('TRIM_HORIZON'), 'TRIM_HORIZON');
    assert.equal(normalizeCfnString('xarn:aws:thing'), 'xarn:aws:thing');
    assert.equal(normalizeCfnString('suc1-3F1C2A9E-ledger'), 'suc1-3F1C2A9E-ledger');
    assert.equal(normalizeCfnString('SucRua-other-3f1c2a9e'), 'SucRua-other-3f1c2a9e');
    assert.equal(normalizeCfnString(''), '');
  });
});

describe('normalizeCfnValue', () => {
  it('names the referenced resource type instead of its logical id', () => {
    assert.deepEqual(normalizeCfnValue({ Ref: 'LedgerA1B2' }, TYPES), { Ref: '<AWS::DynamoDB::Table>' });
    assert.deepEqual(normalizeCfnValue({ 'Fn::GetAtt': ['QueueC3D4', 'Arn'] }, TYPES), {
      'Fn::GetAtt': ['<AWS::SQS::Queue>', 'Arn'],
    });
  });

  it('keeps pseudo parameters, template parameters and unknown references', () => {
    assert.deepEqual(normalizeCfnValue({ Ref: 'AWS::Region' }, TYPES), { Ref: 'AWS::Region' });
    assert.deepEqual(normalizeCfnValue({ Ref: 'BootstrapVersion' }, TYPES), { Ref: 'BootstrapVersion' });
    assert.deepEqual(normalizeCfnValue({ 'Fn::GetAtt': ['Unknown', 'Arn'] }, TYPES), {
      'Fn::GetAtt': ['Unknown', 'Arn'],
    });
  });

  it('normalizes the remaining parts of an unusual GetAtt', () => {
    assert.deepEqual(normalizeCfnValue({ 'Fn::GetAtt': 'QueueC3D4.Arn' }, TYPES), { 'Fn::GetAtt': 'QueueC3D4.Arn' });
    assert.deepEqual(normalizeCfnValue({ 'Fn::GetAtt': [{ Ref: 'QueueC3D4' }, 'Arn'] }, TYPES), {
      'Fn::GetAtt': [{ Ref: '<AWS::SQS::Queue>' }, 'Arn'],
    });
    assert.deepEqual(normalizeCfnValue({ 'Fn::GetAtt': ['LedgerA1B2', 'StreamArn', 'arn:aws:x'] }, TYPES), {
      'Fn::GetAtt': ['<AWS::DynamoDB::Table>', 'StreamArn', '<arn>'],
    });
  });

  it('treats an object with a Ref beside other keys as plain data', () => {
    assert.deepEqual(normalizeCfnValue({ Ref: 'LedgerA1B2', Extra: 1 }, TYPES), { Ref: 'LedgerA1B2', Extra: 1 });
    assert.deepEqual(normalizeCfnValue({ Ref: 5 }, TYPES), { Ref: 5 });
    assert.deepEqual(normalizeCfnValue({ 'Fn::GetAtt': ['LedgerA1B2', 'Arn'], Extra: 'suc1-3f1c2a9e-x' }, TYPES), {
      'Fn::GetAtt': ['LedgerA1B2', 'Arn'],
      Extra: 'suc1-<p>-x',
    });
  });

  it('regression: strips keys before recognizing an intrinsic, so normalization is idempotent', () => {
    // fast-check seed 164051165, path "832:3:3:6:6": the stripped form {Ref} was re-normalized
    // as a reference on the second pass.
    const counterexample = { Properties: { Tags: 'arn:aws:x', Ref: 'LedgerA1B2' } };
    const once = normalizeCfnValue(counterexample, TYPES);
    assert.deepEqual(once, { Properties: { Ref: '<AWS::DynamoDB::Table>' } });
    assert.deepEqual(normalizeCfnValue(once, TYPES), once);
    assert.deepEqual(normalizeCfnValue({ TableName: 'x', 'Fn::GetAtt': ['QueueC3D4', 'Arn'] }, TYPES), {
      'Fn::GetAtt': ['<AWS::SQS::Queue>', 'Arn'],
    });
  });

  it('drops tags and physical names at every depth and recurses into arrays', () => {
    const value = {
      Tags: [{ Key: 'suc:run_id', Value: 'x' }],
      TableName: 'suc1-3f1c2a9e-ledger',
      Nested: [{ RoleName: 'r', QueueName: 'q', Kept: { LogGroupName: 'l', Timeout: 3 } }],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    };
    assert.deepEqual(normalizeCfnValue(value, TYPES), {
      Nested: [{ Kept: { Timeout: 3 } }],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    });
  });

  it('strips exactly the documented keys', () => {
    assert.deepEqual([...STRIPPED_PROPERTY_KEYS].sort(), [
      'BucketName',
      'FunctionName',
      'LogGroupName',
      'ManagedPolicyName',
      'PolicyName',
      'QueueName',
      'RoleName',
      'StreamName',
      'TableName',
      'Tags',
      'TopicName',
    ]);
  });

  it('keeps numbers, booleans and null', () => {
    assert.equal(normalizeCfnValue(30, TYPES), 30);
    assert.equal(normalizeCfnValue(false, TYPES), false);
    assert.equal(normalizeCfnValue(null, TYPES), null);
  });

  it('is total and idempotent over generated JSON (property)', () => {
    const cfnLike: fc.Arbitrary<JsonValue> = fc.letrec<{ value: JsonValue }>((tie) => ({
      value: fc.oneof(
        { depthSize: 'small' },
        fc.constantFrom<JsonValue>('arn:aws:x', 'suc1-3f1c2a9e-a', 'LedgerA1B2', 'AWS::Region', 'Tags', 1, true, null),
        fc.string(),
        fc.record({ Ref: fc.constantFrom('LedgerA1B2', 'QueueC3D4', 'AWS::AccountId', 'Other') }),
        fc.record({
          'Fn::GetAtt': fc.tuple(fc.constantFrom('LedgerA1B2', 'Other'), fc.constantFrom('Arn', 'StreamArn')),
        }),
        fc.array(tie('value'), { maxLength: 4 }),
        fc.dictionary(
          fc.constantFrom('Tags', 'TableName', 'Timeout', 'Ref', 'Fn::GetAtt', 'Properties'),
          tie('value'),
          {
            maxKeys: 4,
          },
        ),
      ),
    })).value;
    fc.assert(
      fc.property(cfnLike, (value) => {
        const once = normalizeCfnValue(value, TYPES);
        assert.deepEqual(normalizeCfnValue(once, TYPES), once);
        assert.equal(hasObjectKey(once, 'Tags'), false);
        assert.equal(hasObjectKey(once, 'TableName'), false);
      }),
      fuzzParameters(),
    );
  });
});
