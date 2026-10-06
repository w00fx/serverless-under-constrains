// The post-deploy SDK-output mappers are total (A-05; design §9.8 D4, §12.5): for any value, of any
// shape, depth or prototype, each returns readings or one `<Operation>OutputMalformed` failure with
// a bounded detail, never throws, and every accepted reading is exact JSON. An output whose listed
// members are all exact JSON is always accepted and records each member as given, absent as null.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import {
  eventSourceMappingOf,
  functionConfigurationOf,
  provisionedConcurrencyOf,
  queueAttributesOf,
  stackDescriptionOf,
  stackResourcePageOf,
  tableDescriptionOf,
} from '../../../src/deployment-assembly/post-deploy-reading.ts';
import type { AttributeReading, PostDeployReadFailure } from '../../../src/deployment-assembly/post-deploy-reading.ts';
import { canonicalJsonIfRepresentable } from '../../../src/record-contract/canonical-json.ts';
import type { Result } from '../../../src/record-contract/primitives.ts';
import { deepTowerArbitrary } from '../../support/kernel/deep-json.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

type Mapper = (output: unknown) => Result<unknown, PostDeployReadFailure>;

const MAPPERS: readonly (readonly [string, Mapper])[] = [
  ['DescribeStacks', stackDescriptionOf],
  ['ListStackResources', stackResourcePageOf],
  ['GetFunctionConfiguration', functionConfigurationOf],
  ['GetEventSourceMapping', eventSourceMappingOf],
  ['GetProvisionedConcurrencyConfig', provisionedConcurrencyOf],
  ['GetQueueAttributes', queueAttributesOf],
  ['DescribeTable', tableDescriptionOf],
];
const MEMBER_NAMES = [
  'Stacks',
  'StackId',
  'StackStatus',
  'Tags',
  'Key',
  'Value',
  'StackResourceSummaries',
  'NextToken',
  'LogicalResourceId',
  'ResourceType',
  'ResourceStatus',
  'PhysicalResourceId',
  'Runtime',
  'MemorySize',
  'Version',
  'Environment',
  'Variables',
  'State',
  'ScalingConfig',
  'Status',
  'Attributes',
  'FifoQueue',
  'Table',
  'StreamSpecification',
  'BillingModeSummary',
  'BillingMode',
  '__proto__',
  'constructor',
  'toString',
];

// Values JSON cannot represent exactly, next to every JSON value.
const hostileLeaf = fc.oneof(
  fc.jsonValue({ maxDepth: 2 }),
  fc.double(),
  fc.constantFrom(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, -0, undefined),
  fc.date({ noInvalidDate: false }),
  fc.bigInt(),
);

// Objects keyed by the member names the mappers read, so the properties reach every branch.
const sdkShaped: fc.Arbitrary<unknown> = fc.letrec<{ node: unknown }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    hostileLeaf,
    fc.array(tie('node'), { maxLength: 3 }),
    fc.dictionary(fc.constantFrom(...MEMBER_NAMES), tie('node'), { maxKeys: 5 }),
  ),
})).node;

function checkTotal(operation: string, result: Result<unknown, PostDeployReadFailure>): void {
  if (!result.ok) {
    assert.equal(result.error.code, `${operation}OutputMalformed`);
    assert.ok(result.error.detail.length <= 600);
    return;
  }
  assert.notEqual(canonicalJsonIfRepresentable(result.value), undefined, 'an accepted answer is exact JSON');
}

describe('post-deploy mappers are total (A-05)', () => {
  it('answer readings or one malformed failure for any value (property)', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.anything({ maxDepth: 3, withNullPrototype: true, withBigInt: true, withDate: true }), sdkShaped),
        (output) => {
          for (const [operation, mapper] of MAPPERS) {
            checkTotal(operation, mapper(output));
          }
        },
      ),
      fuzzParameters(),
    );
  });

  it('never throw on deep members (property)', () => {
    fc.assert(
      fc.property(deepTowerArbitrary(), (tower) => {
        const outputs = [
          { Stacks: [{ StackId: 'a', StackStatus: 'b', Tags: [tower] }] },
          { StackResourceSummaries: [tower] },
          { ScalingConfig: tower, Environment: { Variables: tower } },
          { Attributes: { RedrivePolicy: tower } },
          { Table: { StreamSpecification: tower } },
        ];
        for (const output of outputs) {
          for (const [operation, mapper] of MAPPERS) {
            checkTotal(operation, mapper(output));
          }
        }
      }),
      { ...fuzzParameters(), numRuns: Math.min(fuzzParameters().numRuns, 200) },
    );
  });

  it('record every exact-JSON member as given and every absent one as null (property)', () => {
    const member = fc.option(fc.jsonValue({ maxDepth: 2 }), { nil: undefined });
    fc.assert(
      fc.property(member, member, member, member, (state, batchSize, scaling, filters) => {
        const output = Object.fromEntries(
          Object.entries({
            State: state,
            BatchSize: batchSize,
            ScalingConfig: scaling,
            FilterCriteria: filters,
          }).filter(([, value]) => value !== undefined),
        );
        const read = eventSourceMappingOf(output);
        assert.ok(read.ok);
        const byPath = new Map(read.value.map((reading: AttributeReading) => [reading.attribute_path, reading.value]));
        assert.deepEqual(byPath.get('State'), canonicalCopy(state));
        assert.deepEqual(byPath.get('BatchSize'), canonicalCopy(batchSize));
        assert.deepEqual(byPath.get('ScalingConfig'), canonicalCopy(scaling));
        assert.deepEqual(byPath.get('FilterCriteria'), canonicalCopy(filters));
      }),
      fuzzParameters(),
    );
  });

  it('accept every string or null queue attribute and refuse every other present value (property)', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.constantFrom('FifoQueue', 'VisibilityTimeout', 'Other'), hostileLeaf),
        (attributes) => {
          const read = queueAttributesOf({ Attributes: attributes });
          const listed = ['FifoQueue', 'VisibilityTimeout'].map((name) =>
            Object.hasOwn(attributes, name) ? attributes[name] : undefined,
          );
          // A JSON null records the same as an absent attribute (seed 672990290 found the oracle
          // missing this case); every other present value must be a string.
          const allStrings = listed.every(
            (value) => value === undefined || value === null || typeof value === 'string',
          );
          assert.equal(read.ok, allStrings);
        },
      ),
      fuzzParameters(),
    );
  });
});

// What an exact-JSON member is recorded as: its canonical copy, or null when absent.
function canonicalCopy(value: unknown): unknown {
  const text = value === undefined ? 'null' : canonicalJsonIfRepresentable(value);
  return text === undefined ? undefined : JSON.parse(text);
}
