// The post-deploy read plan over untrusted inputs (A-05; design §9.8 D4, §12.5): the declared
// stack tags of any bytes are sorted string pairs or one DECLARED_TAGS_UNREADABLE reason; every
// planned read resolves against any listed physical id to exactly one request or one reason, and a
// request always names identifiers taken from that physical id; the snapshot of any outcomes keeps
// every answered reading and gives at least one reason per failed read.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import {
  configurationSnapshotOf,
  declaredStackTags,
  resolveReadRequests,
} from '../../../src/deployment-assembly/configuration-reading-plan.ts';
import type { PlannedReadKind, ReadOutcome } from '../../../src/deployment-assembly/configuration-reading-plan.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { RUN_STACK } from '../../support/deployment-assembly/deployment-fixtures.ts';

const encoder = new TextEncoder();
const KINDS: readonly PlannedReadKind[] = [
  'function_configuration',
  'event_source_mapping',
  'provisioned_concurrency',
  'queue',
  'table',
];

// Physical ids near each documented form, and arbitrary text.
const physicalId = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc
    .tuple(fc.stringMatching(/^[A-Za-z0-9_-]{0,70}$/), fc.stringMatching(/^[A-Za-z0-9_$:-]{0,10}$/))
    .map(([name, qualifier]) => `arn:aws:lambda:us-east-1:123456789012:function:${name}:${qualifier}`),
  fc.uuid().map((uuid) => uuid),
  fc.stringMatching(/^[A-Za-z0-9_.-]{0,90}$/).map((name) => `https://sqs.us-east-1.amazonaws.com/123456789012/${name}`),
);

describe('the post-deploy read plan is total (A-05)', () => {
  it('reads sorted string tags or one reason from any bytes (property)', () => {
    const document = fc.oneof(
      fc.uint8Array({ maxLength: 128 }),
      fc.jsonValue({ maxDepth: 4 }).map((value) => encoder.encode(JSON.stringify(value))),
      fc
        .jsonValue({ maxDepth: 2 })
        .map((tags) => encoder.encode(JSON.stringify({ artifacts: { [RUN_STACK]: { properties: { tags } } } }))),
    );
    fc.assert(
      fc.property(document, (bytes) => {
        const tags = declaredStackTags(bytes, RUN_STACK);
        if (!tags.ok) {
          assert.deepEqual([tags.error.code, tags.error.subject], ['DECLARED_TAGS_UNREADABLE', 'BR-RUA-050']);
          return;
        }
        const keys = tags.value.map((tag) => tag.key);
        assert.deepEqual(keys, keys.toSorted());
        assert.ok(tags.value.every((tag) => typeof tag.value === 'string'));
      }),
      fuzzParameters(),
    );
  });

  it('resolves every read to one request or one reason (property)', () => {
    const listed = fc.option(physicalId, { nil: undefined });
    fc.assert(
      fc.property(fc.constantFrom(...KINDS), listed, fc.boolean(), (kind, id, present) => {
        const resources = present
          ? [
              {
                logical_id: 'Target',
                resource_type: 'AWS::X::Y',
                resource_status: 'CREATE_COMPLETE',
                ...(id === undefined ? {} : { physical_id: id }),
              },
            ]
          : [];
        const resolved = resolveReadRequests([{ kind, logical_id: 'Target' }], resources);
        assert.equal(resolved.requests.length + resolved.reasons.length, 1);
        const [request] = resolved.requests;
        if (request === undefined) {
          assert.equal(resolved.reasons[0]?.code, 'READ_TARGET_UNRESOLVED');
          return;
        }
        assert.ok(present && id !== undefined);
        const named = Object.values(request).filter((value) => value !== kind && value !== 'Target');
        assert.ok(
          named.every((value) => id.includes(value)),
          JSON.stringify(request),
        );
      }),
      fuzzParameters(),
    );
  });

  it('keeps every answered reading and a reason per failed read (property)', () => {
    const outcome: fc.Arbitrary<ReadOutcome> = fc.record({
      request: fc.constantFrom<ReadOutcome['request']>(
        { kind: 'function_configuration', logical_id: 'Version', function_name: 'f', qualifier: '7' },
        { kind: 'provisioned_concurrency', logical_id: 'Alias', function_name: 'f', qualifier: 'live' },
        { kind: 'queue', logical_id: 'Queue', queue_url: 'https://sqs.us-east-1.amazonaws.com/123456789012/q' },
      ),
      answer: fc.oneof(
        fc.record({ code: fc.string(), detail: fc.string() }).map((error) => ({ ok: false as const, error })),
        fc
          .array(
            fc.record({
              attribute_path: fc.constantFrom('Version', 'ProvisionedConcurrencyConfig', 'State'),
              value: fc.jsonValue({ maxDepth: 2 }) as fc.Arbitrary<JsonValue>,
            }),
            { maxLength: 4 },
          )
          .map((value) => ({ ok: true as const, value })),
      ),
    });
    fc.assert(
      fc.property(fc.array(outcome, { maxLength: 6 }), (outcomes) => {
        const snapshot = configurationSnapshotOf(outcomes);
        const answered = outcomes.flatMap((entry) => (entry.answer.ok ? entry.answer.value : []));
        const failed = outcomes.filter((entry) => !entry.answer.ok).length;
        assert.equal(snapshot.readings.length, answered.length);
        assert.ok(snapshot.reasons.length >= failed);
        assert.ok(snapshot.reasons.every((reason) => /^[A-Z][A-Z0-9_]*$/.test(reason.code) && reason.detail !== ''));
      }),
      fuzzParameters(),
    );
  });
});
