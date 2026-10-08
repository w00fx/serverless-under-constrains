// normalizeCfnValue is total and idempotent over generated CloudFormation-like JSON (BR-RUA-028;
// testing rule 6). The example cases are in test/unit/transport-qualification/scope/cfn-value-normalization.test.ts; the property lives here so
// `npm run test:fuzz` and `fuzz:campaign` reach it (Owner amendment A-11).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import { normalizeCfnValue } from '../../../../src/transport-qualification/scope/cfn-value-normalization.ts';
import { fuzzParameters } from '../../../support/kernel/fuzz-parameters.ts';
import { LOGICAL_ID_IDENTITIES as IDENTITIES } from '../../../unit/transport-qualification/scope/support/template-samples.ts';

function hasObjectKey(value: JsonValue, key: string): boolean {
  if (Array.isArray(value)) {
    return (value as readonly JsonValue[]).some((item) => hasObjectKey(item, key));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(([name, inner]) => name === key || hasObjectKey(inner, key));
  }
  return false;
}

describe('normalizeCfnValue', () => {
  it('is total and idempotent over generated JSON (property)', () => {
    const cfnLike: fc.Arbitrary<JsonValue> = fc.letrec<{ value: JsonValue }>((tie) => ({
      value: fc.oneof(
        { depthSize: 'small' },
        fc.constantFrom<JsonValue>('arn:aws:x', 'suc1-3f1c2a9e-a', 'LedgerA1B2', 'AWS::Region', 'Tags', 1, true, null),
        // Non-finite leaves (A-05): JSON.parse('1e400') yields Infinity; normalization keeps them.
        fc.constantFrom<JsonValue>(Infinity, -Infinity, Number.NaN),
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
        const once = normalizeCfnValue(value, IDENTITIES);
        assert.deepEqual(normalizeCfnValue(once, IDENTITIES), once);
        assert.equal(hasObjectKey(once, 'Tags'), false);
        assert.equal(hasObjectKey(once, 'TableName'), false);
      }),
      fuzzParameters(),
    );
  });
});
