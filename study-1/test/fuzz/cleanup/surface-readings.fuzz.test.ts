// Design §12.5 for cleanup's SDK-output readings (Owner amendment A-05, BR-RUA-051): every AWS
// answer cleanup reads is untrusted input. Over arbitrary values, including hostile members
// (non-finite numbers such as `1e400`, inherited names, boxed and exotic values) and towers
// 100,000 levels deep, every reading returns a result and never throws, with a bounded reason;
// over well-formed service shapes, each reading keeps the values exactly.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { consumerStateOutcome, dlqReceiveOutcome, stackReadOutcome } from '../../../src/cleanup/sdk-call-outcomes.ts';
import type { Reading } from '../../../src/cleanup/surface-readings.ts';
import {
  instantOfMillis,
  optionalInstant,
  sdkFailureOf,
  tagMap,
  tagPairs,
} from '../../../src/cleanup/surface-readings.ts';
import {
  durableExecutionsPage,
  durableStatusReading,
  functionAliasesPage,
  functionReading,
  functionVersionsPage,
  mappingReading,
  mappingsPage,
  qualifiedFunctionParts,
  runningExecutionArnsPage,
} from '../../../src/cleanup/surface-readings-lambda.ts';
import {
  logGroupsPage,
  queueCreatedAt,
  queueUrlOfArn,
  queueUrlReading,
  queueUrlsPage,
  receivedDlqMessages,
  resourceTypeOfArn,
  roleNameOfArn,
  roleReading,
  roleTagsPage,
  skippedStackResourcesPage,
  stackReading,
  stackResourcesPage,
  tableReading,
  tableTagsPage,
  tagIndexPage,
} from '../../../src/cleanup/surface-readings-services.ts';
import { ok } from '../../../src/record-contract/primitives.ts';
import { DEEP_NESTING, parsedTower } from '../../support/kernel/deep-json.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

/** The longest reason detail a reading may return: bounded quotes of the offending value plus prose. */
const DETAIL_BOUND = 4096;
const STACK_ID = 'arn:aws:cloudformation:us-east-1:123456789012:stack/s/0f0e';

/** Every reading of SDK output, by name. */
const READINGS: readonly (readonly [string, (output: unknown) => Reading<unknown>])[] = [
  ['tagMap', (output: unknown): Reading<unknown> => tagMap(output, 'Tags', 'ListTags')],
  ['tagPairs', (output: unknown): Reading<unknown> => tagPairs(output, 'ListRoleTags')],
  ['optionalInstant', (output: unknown): Reading<unknown> => optionalInstant(output, 'CreateDate', 'GetRole')],
  ['functionReading', functionReading],
  ['functionVersionsPage', functionVersionsPage],
  ['functionAliasesPage', functionAliasesPage],
  ['mappingReading', (output: unknown): Reading<unknown> => mappingReading(output)],
  ['mappingsPage', mappingsPage],
  ['durableExecutionsPage', (output: unknown): Reading<unknown> => durableExecutionsPage(output, STACK_ID)],
  ['durableStatusReading', durableStatusReading],
  ['runningExecutionArnsPage', runningExecutionArnsPage],
  ['tagIndexPage', tagIndexPage],
  ['stackReading', stackReading],
  ['stackResourcesPage', (output: unknown): Reading<unknown> => stackResourcesPage(output, STACK_ID)],
  ['skippedStackResourcesPage', (output: unknown): Reading<unknown> => skippedStackResourcesPage(output, STACK_ID)],
  ['queueUrlReading', queueUrlReading],
  ['queueUrlsPage', queueUrlsPage],
  ['queueCreatedAt', queueCreatedAt],
  ['receivedDlqMessages', receivedDlqMessages],
  ['tableReading', tableReading],
  ['roleReading', roleReading],
  ['tableTagsPage', tableTagsPage],
  ['roleTagsPage', roleTagsPage],
  ['logGroupsPage', logGroupsPage],
  ['consumerStateOutcome', (output: unknown): Reading<unknown> => portReading(consumerStateOutcome(ok(output), 'u'))],
  ['stackReadOutcome', (output: unknown): Reading<unknown> => portReading(stackReadOutcome(ok(output), STACK_ID))],
  ['dlqReceiveOutcome', (output: unknown): Reading<unknown> => portReading(dlqReceiveOutcome(ok(output), 'https://q'))],
];

function assertEveryReadingTotal(holder: unknown): void {
  for (const [name, read] of READINGS) {
    assertTotal(name, read, holder);
  }
}

/** The member names the readings look up, so hostile values land where they are read. */
const MEMBER_NAMES = [
  'Tags',
  'tags',
  'Key',
  'Value',
  'Configuration',
  'FunctionName',
  'FunctionArn',
  'Versions',
  'Version',
  'Aliases',
  'AliasArn',
  'NextMarker',
  'UUID',
  'State',
  'EventSourceMappingArn',
  'EventSourceMappings',
  'DurableExecutions',
  'DurableExecutionArn',
  'Status',
  'StartTimestamp',
  'ResourceTagMappingList',
  'ResourceARN',
  'PaginationToken',
  'Stacks',
  'StackId',
  'StackStatus',
  'CreationTime',
  'StackResourceSummaries',
  'StackEvents',
  'ResourceType',
  'ResourceStatus',
  'PhysicalResourceId',
  'NextToken',
  'QueueUrl',
  'QueueUrls',
  'Attributes',
  'CreatedTimestamp',
  'Messages',
  'MessageId',
  'ReceiptHandle',
  'Table',
  'TableName',
  'TableArn',
  'CreationDateTime',
  'Role',
  'RoleName',
  'Arn',
  'CreateDate',
  'IsTruncated',
  'Marker',
  'logGroups',
  'logGroupName',
  'logGroupArn',
  'arn',
  'creationTime',
  'nextToken',
  'toString',
  'valueOf',
  '__proto__',
  'constructor',
] as const;

const hostileLeaf: fc.Arbitrary<unknown> = fc.oneof(
  fc.anything({
    maxDepth: 2,
    withBigInt: true,
    withBoxedValues: true,
    withDate: true,
    withMap: true,
    withNullPrototype: true,
    withObjectString: true,
    withSet: true,
    withSparseArray: true,
    withTypedArray: true,
  }),
  fc.constantFrom(
    Infinity,
    -Infinity,
    Number.NaN,
    JSON.parse('1e400') as number,
    -0,
    2 ** 53,
    new Date(Number.NaN),
    new Date(8.64e15),
    '1e400',
    '',
  ),
  // Towers parsed once: generating one per sample made the campaign spend its time in the parser.
  fc.constantFrom(
    ...(['array', 'object', 'mixed'] as const).flatMap((shape) => [
      parsedTower(shape, 2_500),
      parsedTower(shape, 20_000),
    ]),
  ),
);

/** An object of hostile members under the names the readings read, own or inherited. */
function hostileHolder(inner: fc.Arbitrary<unknown>): fc.Arbitrary<unknown> {
  return fc
    .record({
      own: fc.dictionary(fc.constantFrom(...MEMBER_NAMES), inner, { maxKeys: 8 }),
      inherited: fc.dictionary(fc.constantFrom(...MEMBER_NAMES), inner, { maxKeys: 4 }),
    })
    .map(({ own, inherited }) => Object.assign(Object.create(inherited) as object, own));
}

// Two levels of holders, and lists of them, so list entries and nested members are reached too.
const nestedHolder = hostileHolder(fc.oneof(hostileLeaf, fc.array(hostileHolder(hostileLeaf), { maxLength: 3 })));
const untrusted: fc.Arbitrary<unknown> = fc.oneof(
  hostileLeaf,
  nestedHolder,
  hostileHolder(fc.oneof(nestedHolder, fc.array(nestedHolder, { maxLength: 3 }))),
);

function portReading(outcome: { readonly kind: string; readonly reason?: unknown }): Reading<unknown> {
  return outcome.kind === 'failed' ? { ok: false, error: outcome.reason as never } : ok(outcome);
}

function assertTotal(name: string, read: (output: unknown) => Reading<unknown>, output: unknown): void {
  const reading = read(output);
  if (reading.ok) {
    return;
  }
  const { code, subject, detail } = reading.error;
  assert.equal(typeof code, 'string', name);
  assert.equal(typeof subject, 'string', name);
  assert.ok(detail.length <= DETAIL_BOUND, `${name}: detail of ${String(detail.length)} chars`);
}

describe('cleanup SDK-output readings are total over untrusted values', () => {
  it('every reading returns a result with a bounded reason and never throws', () => {
    fc.assert(
      fc.property(untrusted, (output) => {
        for (const [name, read] of READINGS) {
          assertTotal(name, read, output);
        }
      }),
      fuzzParameters(),
    );
  });

  it('every reading survives 100,000-level towers under every member it reads', () => {
    for (const shape of ['array', 'object', 'mixed'] as const) {
      const tower = parsedTower(shape, DEEP_NESTING);
      const holders: unknown[] = [
        tower,
        Object.fromEntries(MEMBER_NAMES.map((name) => [name, tower])),
        Object.fromEntries(
          MEMBER_NAMES.map((name) => [name, [Object.fromEntries(MEMBER_NAMES.map((n) => [n, tower]))]]),
        ),
      ];
      holders.forEach(assertEveryReadingTotal);
    }
  });

  it('never reads 1e400 or any non-finite or fractional number as an instant', () => {
    const overflow = JSON.parse('1e400') as number;
    for (const refused of [overflow, -overflow, Number.NaN, 1.5, 2 ** 53]) {
      assert.equal(instantOfMillis(refused), undefined, String(refused));
      assert.equal(logGroupsPage({ logGroups: [{ logGroupName: 'g', arn: 'a', creationTime: refused }] }).ok, false);
    }
    assert.equal(queueCreatedAt({ Attributes: { CreatedTimestamp: '1e400' } }).ok, false);
    assert.equal(optionalInstant({ D: new Date(overflow) }, 'D', 'Op').ok, false);
  });

  it('reads no member that is only inherited', () => {
    const inherit = (members: object): unknown => Object.create(members) as unknown;
    assert.equal(functionReading(inherit({ Configuration: { FunctionName: 'f', FunctionArn: 'a' } })).ok, false);
    assert.equal(mappingReading(inherit({ UUID: 'u', State: 'Enabled' })).ok, false);
    assert.equal(queueUrlReading(inherit({ QueueUrl: 'https://q' })).ok, false);
    assert.equal(roleReading({ Role: inherit({ RoleName: 'r', Arn: 'a' }) }).ok, false);
    assert.deepEqual(queueUrlsPage(inherit({ QueueUrls: ['https://q'], NextToken: 't' })), ok({ items: [] }));
    assert.deepEqual(tagMap({ Tags: inherit({ k: 'v' }) }, 'Tags', 'ListTags'), ok([]));
    assert.deepEqual(sdkFailureOf(inherit({ name: 'ResourceNotFoundException', message: 'm' })), {
      name: 'UnnamedSdkFailure',
      message: '',
    });
  });

  it('reads any thrown value as a named failure and any text as an ARN type', () => {
    fc.assert(
      fc.property(untrusted, fc.string({ unit: 'binary', maxLength: 200 }), (thrown, text) => {
        const failure = sdkFailureOf(thrown);
        assert.ok(failure.name.length > 0 && failure.name.length <= 64);
        assert.equal(typeof failure.message, 'string');
        assert.equal(typeof resourceTypeOfArn(text), 'string');
        qualifiedFunctionParts(text);
        roleNameOfArn(text);
        queueUrlOfArn(text);
      }),
      fuzzParameters(),
    );
  });
});

const name = fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/);
const tagText = fc.string({ maxLength: 40 });
const epochSeconds = fc.integer({ min: 0, max: 253_402_300_799 });

describe('cleanup SDK-output readings keep well-formed shapes exactly', () => {
  it('tags round-trip through a tag map and through tag pairs', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), tagText, { maxKeys: 10 }), (tags) => {
        const entries = Object.entries(tags).map(([key, value]) => ({ key, value }));
        assert.deepEqual(tagMap({ Tags: tags }, 'Tags', 'ListTags'), ok(entries));
        const pairs = entries.map(({ key, value }) => ({ Key: key, Value: value }));
        assert.deepEqual(tagPairs({ Tags: pairs }, 'ListRoleTags'), ok(entries));
      }),
      fuzzParameters(),
    );
  });

  it('queue and role ARNs read back the name, Region and account they were built from', () => {
    fc.assert(
      fc.property(
        name,
        fc.stringMatching(/^[a-z]{2}-[a-z]+-[0-9]$/),
        fc.stringMatching(/^[0-9]{12}$/),
        (n, region, account) => {
          assert.equal(
            queueUrlOfArn(`arn:aws:sqs:${region}:${account}:${n}`),
            `https://sqs.${region}.amazonaws.com/${account}/${n}`,
          );
          assert.equal(roleNameOfArn(`arn:aws:iam::${account}:role/path/${n}`), n);
          const parts = qualifiedFunctionParts(`arn:aws:lambda:${region}:${account}:function:${n}:7`);
          assert.deepEqual(parts, {
            function_arn: `arn:aws:lambda:${region}:${account}:function:${n}`,
            function_name: n,
            qualifier: '7',
          });
        },
      ),
      fuzzParameters(),
    );
  });

  it('queue creation times round-trip through epoch seconds', () => {
    fc.assert(
      fc.property(epochSeconds, (seconds) => {
        const created = queueCreatedAt({ Attributes: { CreatedTimestamp: String(seconds) } });
        assert.ok(created.ok && created.value !== undefined);
        assert.equal(Date.parse(created.value), seconds * 1000);
      }),
      fuzzParameters(),
    );
  });

  it('listings keep every entry and the cursor', () => {
    fc.assert(
      fc.property(fc.array(name, { maxLength: 12 }), fc.option(name, { nil: undefined }), (names, cursor) => {
        const next = cursor === undefined ? {} : { cursor };
        const urls = names.map((n) => `https://sqs.us-east-1.amazonaws.com/123456789012/${n}`);
        assert.deepEqual(queueUrlsPage({ QueueUrls: urls, NextToken: cursor }), ok({ items: urls, ...next }));
        const messages = names.map((n) => ({ MessageId: n, ReceiptHandle: `r-${n}` }));
        assert.deepEqual(
          receivedDlqMessages({ Messages: messages }),
          ok(names.map((n) => ({ message_id: n, receipt_handle: `r-${n}` }))),
        );
        const mappings = names.map((n) => ({ UUID: n, State: 'Enabled' }));
        assert.deepEqual(
          mappingsPage({ EventSourceMappings: mappings, NextMarker: cursor }),
          ok({ items: names.map((n) => ({ uuid: n, state: 'Enabled' })), ...next }),
        );
      }),
      fuzzParameters(),
    );
  });
});
