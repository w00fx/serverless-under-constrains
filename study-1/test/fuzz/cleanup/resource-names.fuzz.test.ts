// Property targets `canonicalResourceName` and `resourceKey` (BR-RUA-050 membership, design §9.7
// and §9.14). Identifiers come from discovery surfaces, so they are untrusted text: for any type
// and identifier the canonical name is the identifier or a part of it, and for any well-formed
// name in any region and account, the tag-index ARN and the physical id CloudFormation records
// give the same key.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { canonicalResourceName, resourceKey } from '../../../src/cleanup/resource-names.ts';
import {
  EVENT_SOURCE_MAPPING_RESOURCE_TYPE,
  FUNCTION_RESOURCE_TYPE,
  LOG_GROUP_RESOURCE_TYPE,
  QUEUE_RESOURCE_TYPE,
  STACK_RESOURCE_TYPE,
  TABLE_RESOURCE_TYPE,
} from '../../../src/cleanup/resource-types.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const KNOWN_TYPES = [
  STACK_RESOURCE_TYPE,
  QUEUE_RESOURCE_TYPE,
  FUNCTION_RESOURCE_TYPE,
  EVENT_SOURCE_MAPPING_RESOURCE_TYPE,
  TABLE_RESOURCE_TYPE,
  LOG_GROUP_RESOURCE_TYPE,
];

const arnText = fc.string({ unit: fc.constantFrom('a', ':', '/', '*', 'arn', 'aws', 'sqs', 'table', '-', '1') });
const identifier = fc.oneof(fc.string(), arnText, fc.string({ unit: 'binary', maxLength: 64 }));
const resourceType = fc.oneof(
  fc.constantFrom(...KNOWN_TYPES, 'constructor', '__proto__'),
  fc.string({ maxLength: 12 }),
);

// A name valid for every type below: no `:` (an ARN separator) and no `/`.
const name = fc.stringMatching(/^[A-Za-z0-9._-]{1,40}$/);
const segment = fc.stringMatching(/^[a-z0-9-]{0,14}$/);

interface ArnForm {
  readonly type: string;
  readonly arn: string;
  readonly physicalId: string;
}

const arnForm: fc.Arbitrary<ArnForm> = fc
  .record({ name, region: segment, account: segment })
  .chain(({ name: n, region, account }) => {
    const at = `${region}:${account}`;
    return fc.constantFrom<ArnForm>(
      { type: QUEUE_RESOURCE_TYPE, arn: `arn:aws:sqs:${at}:${n}`, physicalId: `https://sqs.host/${account}x/${n}` },
      { type: FUNCTION_RESOURCE_TYPE, arn: `arn:aws:lambda:${at}:function:${n}`, physicalId: n },
      {
        type: EVENT_SOURCE_MAPPING_RESOURCE_TYPE,
        arn: `arn:aws:lambda:${at}:event-source-mapping:${n}`,
        physicalId: n,
      },
      { type: TABLE_RESOURCE_TYPE, arn: `arn:aws:dynamodb:${at}:table/${n}`, physicalId: n },
      { type: LOG_GROUP_RESOURCE_TYPE, arn: `arn:aws:logs:${at}:log-group:/suc/${n}:*`, physicalId: `/suc/${n}` },
    );
  });

describe('canonicalResourceName properties', () => {
  it('is total and returns the identifier or a part of it', () => {
    fc.assert(
      fc.property(resourceType, identifier, (type, id) => {
        const canonical = canonicalResourceName(type, id);
        assert.ok(id.includes(canonical), `${JSON.stringify(canonical)} is not part of ${JSON.stringify(id)}`);
        assert.ok(canonical.length > 0 || id.length === 0);
      }),
      fuzzParameters(),
    );
  });

  it('gives the tag-index ARN and the recorded physical id one key', () => {
    fc.assert(
      fc.property(arnForm, (form) => {
        assert.equal(
          resourceKey({ resource_type: form.type, identifier: form.arn }),
          resourceKey({ resource_type: form.type, identifier: form.physicalId }),
        );
      }),
      fuzzParameters(),
    );
  });
});
