// Normalization strips execution identity (names, tags, ARNs, ids, logical ids) and keeps
// configuration and resource identity (BR-RUA-028, BR-RUA-050 names and tags). The property
// (normalization is total and idempotent) is in
// test/fuzz/transport-qualification/scope/cfn-value-normalization.fuzz.test.ts (Owner amendment A-11).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import {
  STRIPPED_PROPERTY_KEYS,
  normalizeCfnString,
  normalizeCfnValue,
} from '../../../../src/transport-qualification/scope/cfn-value-normalization.ts';
import { LOGICAL_ID_IDENTITIES as IDENTITIES } from './support/template-samples.ts';

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
  it('names the referenced resource by its identity instead of its logical id', () => {
    assert.deepEqual(normalizeCfnValue({ Ref: 'LedgerA1B2' }, IDENTITIES), { Ref: '<ExperimentCore/Ledger/Resource>' });
    assert.deepEqual(normalizeCfnValue({ 'Fn::GetAtt': ['QueueC3D4', 'Arn'] }, IDENTITIES), {
      'Fn::GetAtt': ['<ExperimentCore/Queue/Resource>', 'Arn'],
    });
  });

  it('keeps pseudo parameters, template parameters and unknown references', () => {
    assert.deepEqual(normalizeCfnValue({ Ref: 'AWS::Region' }, IDENTITIES), { Ref: 'AWS::Region' });
    assert.deepEqual(normalizeCfnValue({ Ref: 'BootstrapVersion' }, IDENTITIES), { Ref: 'BootstrapVersion' });
    assert.deepEqual(normalizeCfnValue({ 'Fn::GetAtt': ['Unknown', 'Arn'] }, IDENTITIES), {
      'Fn::GetAtt': ['Unknown', 'Arn'],
    });
  });

  it('normalizes the remaining parts of an unusual GetAtt', () => {
    assert.deepEqual(normalizeCfnValue({ 'Fn::GetAtt': 'QueueC3D4.Arn' }, IDENTITIES), {
      'Fn::GetAtt': 'QueueC3D4.Arn',
    });
    assert.deepEqual(normalizeCfnValue({ 'Fn::GetAtt': [{ Ref: 'QueueC3D4' }, 'Arn'] }, IDENTITIES), {
      'Fn::GetAtt': [{ Ref: '<ExperimentCore/Queue/Resource>' }, 'Arn'],
    });
    assert.deepEqual(normalizeCfnValue({ 'Fn::GetAtt': ['LedgerA1B2', 'StreamArn', 'arn:aws:x'] }, IDENTITIES), {
      'Fn::GetAtt': ['<ExperimentCore/Ledger/Resource>', 'StreamArn', '<arn>'],
    });
  });

  it('treats an object with a Ref beside other keys as plain data', () => {
    assert.deepEqual(normalizeCfnValue({ Ref: 'LedgerA1B2', Extra: 1 }, IDENTITIES), { Ref: 'LedgerA1B2', Extra: 1 });
    assert.deepEqual(normalizeCfnValue({ Ref: 5 }, IDENTITIES), { Ref: 5 });
    assert.deepEqual(normalizeCfnValue({ 'Fn::GetAtt': ['LedgerA1B2', 'Arn'], Extra: 'suc1-3f1c2a9e-x' }, IDENTITIES), {
      'Fn::GetAtt': ['LedgerA1B2', 'Arn'],
      Extra: 'suc1-<p>-x',
    });
  });

  it('regression: strips keys before recognizing an intrinsic, so normalization is idempotent', () => {
    // fast-check seed 164051165, path "832:3:3:6:6": the stripped form {Ref} was re-normalized
    // as a reference on the second pass.
    const counterexample = { Properties: { Tags: 'arn:aws:x', Ref: 'LedgerA1B2' } };
    const once = normalizeCfnValue(counterexample, IDENTITIES);
    assert.deepEqual(once, { Properties: { Ref: '<ExperimentCore/Ledger/Resource>' } });
    assert.deepEqual(normalizeCfnValue(once, IDENTITIES), once);
    assert.deepEqual(normalizeCfnValue({ TableName: 'x', 'Fn::GetAtt': ['QueueC3D4', 'Arn'] }, IDENTITIES), {
      'Fn::GetAtt': ['<ExperimentCore/Queue/Resource>', 'Arn'],
    });
  });

  it('drops tags and physical names at every depth and recurses into arrays', () => {
    const value = {
      Tags: [{ Key: 'suc:run_id', Value: 'x' }],
      TableName: 'suc1-3f1c2a9e-ledger',
      Nested: [{ RoleName: 'r', QueueName: 'q', Kept: { LogGroupName: 'l', Timeout: 3 } }],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    };
    assert.deepEqual(normalizeCfnValue(value, IDENTITIES), {
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

  it('keeps a parsed __proto__ key as a key instead of replacing the prototype', () => {
    const parsed = JSON.parse('{"__proto__":{"Ref":"LedgerA1B2"},"Timeout":3}') as JsonValue;
    const normalized = normalizeCfnValue(parsed, IDENTITIES);
    assert.deepEqual(Object.keys(normalized as object), ['__proto__', 'Timeout']);
    assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
    assert.equal(JSON.stringify(normalized), '{"__proto__":{"Ref":"<ExperimentCore/Ledger/Resource>"},"Timeout":3}');
  });

  it('keeps numbers, booleans and null', () => {
    assert.equal(normalizeCfnValue(30, IDENTITIES), 30);
    assert.equal(normalizeCfnValue(false, IDENTITIES), false);
    assert.equal(normalizeCfnValue(null, IDENTITIES), null);
  });
});
