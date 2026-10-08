// Property tests of the execution lifecycle's untrusted-input boundaries (testing rule 6; A-05
// totality): the frozen execution-manifest bytes the runner and `rua recover` admit, and the stack
// outputs a resource manifest records. Over any bytes and any JSON (towers nested past the call
// stack, out-of-range numbers and inherited member names included) each one answers without
// throwing; an admitted execution is bound to the digest of exactly the bytes read, a resolved
// target is consistent with the outputs it came from, and every refusal detail stays bounded.
// Runs FC_RUNS cases per property (10,000 under `npm run test:fuzz`).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { readAdmittedExecution } from '../../../src/execution-lifecycle/admitted-execution.ts';
import {
  executionTargetsOf,
  queueNameOf,
  STACK_OUTPUT_KEYS,
} from '../../../src/execution-lifecycle/execution-targets.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonValue, Result, StructuredReason } from '../../../src/record-contract/primitives.ts';
import type { ResourceManifest } from '../../../src/record-contract/records/group-a/resource_manifest.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { towerText } from '../../support/kernel/deep-json.ts';
import type { TowerShape } from '../../support/kernel/deep-json.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { offlineExecution } from '../../support/offline-cloud/offline-execution.ts';

const MAX_DETAIL = 2_000;
const validator = createRecordValidator();
const encoder = new TextEncoder();
const INHERITED_NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];
const execution = offlineExecution('run');
const MANIFEST_BYTES = execution.core_files.get(EXECUTION_PATHS.executionManifest) ?? new Uint8Array();
const MANIFEST = JSON.parse(new TextDecoder().decode(MANIFEST_BYTES)) as Readonly<Record<string, JsonValue>>;
const RESOURCE_MANIFEST = JSON.parse(
  new TextDecoder().decode(execution.core_files.get(EXECUTION_PATHS.resourceManifest)),
) as ResourceManifest;

const hostileLeaf: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.constantFrom<JsonValue>(-0, 2 ** 53, '', 'RUN', 'VARIANT_VALIDATION', 'TRANSPORT_PROBE'),
  fc.jsonValue({ maxDepth: 2 }) as fc.Arbitrary<JsonValue>,
);

const inheritedObject: fc.Arbitrary<JsonValue> = fc
  .dictionary(fc.constantFrom(...INHERITED_NAMES), hostileLeaf, { maxKeys: 3 })
  .map((members) => JSON.parse(JSON.stringify(members)) as JsonValue);

// The frozen manifest with one member replaced or removed, so most values reach the deeper checks.
const nearManifest: fc.Arbitrary<JsonValue> = fc
  .tuple(fc.constantFrom(...Object.keys(MANIFEST), ...INHERITED_NAMES), fc.option(hostileLeaf, { nil: undefined }))
  .map(([member, value]) => {
    const copy: Record<string, JsonValue> = Object.fromEntries(
      Object.entries(MANIFEST).filter(([name]) => name !== member),
    );
    if (value !== undefined) {
      Object.defineProperty(copy, member, { value, enumerable: true, writable: true, configurable: true });
    }
    return copy;
  });

const anyDocument: fc.Arbitrary<Uint8Array> = fc.oneof(
  { arbitrary: fc.uint8Array({ maxLength: 256 }), weight: 10 },
  {
    arbitrary: (fc.jsonValue() as fc.Arbitrary<JsonValue>).map((value) => encoder.encode(JSON.stringify(value))),
    weight: 20,
  },
  { arbitrary: inheritedObject.map((value) => encoder.encode(JSON.stringify(value))), weight: 5 },
  { arbitrary: nearManifest.map((value) => encoder.encode(`${JSON.stringify(value)}\n`)), weight: 20 },
  {
    arbitrary: fc
      .constantFrom('1e400', '-1e400', '{"schema_version":1e400}', '﻿{}', '{"a":1}{"b":2}')
      .map((text) => encoder.encode(text)),
    weight: 2,
  },
  {
    arbitrary: fc
      .record({
        shape: fc.constantFrom<TowerShape>('array', 'object', 'mixed'),
        depth: fc.integer({ min: 1, max: 20_000 }),
      })
      .map(({ shape, depth }) => encoder.encode(towerText(shape, depth, '1'))),
    weight: 1,
  },
);

function assertBoundedRefusal<T>(result: Result<T, StructuredReason>): void {
  if (!result.ok) {
    assert.ok(result.error.code.length > 0);
    assert.ok(result.error.detail.length > 0 && result.error.detail.length <= MAX_DETAIL, result.error.detail);
  }
}

const outputKey: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: fc.constantFrom(...Object.values(STACK_OUTPUT_KEYS)), weight: 8 },
  { arbitrary: fc.constantFrom('ProviderQualifier', ...INHERITED_NAMES), weight: 1 },
  { arbitrary: fc.string({ maxLength: 12 }), weight: 1 },
);

// Queue URLs and ARNs, well formed or not, so both the resolved and the refused paths are reached.
const outputValue: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    'https://sqs.ca-central-1.amazonaws.com/012345678901/suc1-a-conventional-source.fifo',
    'https://sqs.ca-central-1.amazonaws.com/012345678901/',
    'arn:aws:lambda:ca-central-1:012345678901:function:suc1-a-durable-caller',
    'arn:aws:lambda:ca-central-1:012345678901:function:suc1-a-durable-caller:live',
    'arn:aws:lambda:ca-central-1:012345678901:function:suc1-a-durable-caller:bad alias',
    '',
  ),
  fc.string({ maxLength: 3_000 }),
);

interface OutputEntry {
  readonly key: string;
  readonly value: string;
}

const QUEUE_URL = 'https://sqs.ca-central-1.amazonaws.com/012345678901/suc1-a';
const CALLER_ARN = 'arn:aws:lambda:ca-central-1:012345678901:function:suc1-a-durable-caller';

// What a deployed stack records: each variant's two queues and the caller's three outputs, each
// group present or not, with one entry possibly replaced, so the resolved paths are reached too.
const deployedOutputs: fc.Arbitrary<readonly OutputEntry[]> = fc
  .record({
    conventional: fc.boolean(),
    durable: fc.boolean(),
    alias: fc.option(fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/), { nil: undefined }),
    replaced: fc.option(fc.record({ index: fc.nat(6), value: outputValue }), { nil: undefined }),
  })
  .map(({ conventional, durable, alias, replaced }) => {
    const entries: OutputEntry[] = [
      ...(conventional
        ? [
            { key: STACK_OUTPUT_KEYS.conventionalSourceQueueUrl, value: `${QUEUE_URL}-conventional-source.fifo` },
            { key: STACK_OUTPUT_KEYS.conventionalDeadLetterQueueUrl, value: `${QUEUE_URL}-conventional-dlq.fifo` },
          ]
        : []),
      ...(durable
        ? [
            { key: STACK_OUTPUT_KEYS.durableSourceQueueUrl, value: `${QUEUE_URL}-durable-source.fifo` },
            { key: STACK_OUTPUT_KEYS.durableDeadLetterQueueUrl, value: `${QUEUE_URL}-durable-dlq.fifo` },
          ]
        : []),
      ...(alias === undefined
        ? []
        : [
            { key: STACK_OUTPUT_KEYS.durableCallerFunctionName, value: 'suc1-a-durable-caller' },
            { key: STACK_OUTPUT_KEYS.durableCallerFunctionArn, value: CALLER_ARN },
            { key: STACK_OUTPUT_KEYS.durableCallerAliasArn, value: `${CALLER_ARN}:${alias}` },
          ]),
    ];
    const at = replaced === undefined ? -1 : replaced.index % Math.max(entries.length, 1);
    return entries.map((entry, index) => (index === at ? { key: entry.key, value: replaced?.value ?? '' } : entry));
  });

const resourceManifest: fc.Arbitrary<ResourceManifest> = fc
  .record({
    provisioning_status: fc.constantFrom('succeeded', 'succeeded', 'partial', 'failed'),
    outputs: fc.oneof(fc.array(fc.record({ key: outputKey, value: outputValue }), { maxLength: 9 }), deployedOutputs),
  })
  .map(
    ({ provisioning_status, outputs }) => ({ ...RESOURCE_MANIFEST, provisioning_status, outputs }) as ResourceManifest,
  );

describe('readAdmittedExecution', () => {
  it('admits any bytes without throwing, bound to the digest of exactly those bytes', () => {
    fc.assert(
      fc.property(anyDocument, (bytes) => {
        const admitted = readAdmittedExecution(bytes, validator);
        assertBoundedRefusal(admitted);
        if (admitted.ok) {
          assert.equal(admitted.value.manifest_sha256, sha256Hex(bytes));
          assert.equal(admitted.value.identity.execution_kind, admitted.value.manifest.execution_kind);
          assert.equal(admitted.value.package_directory, PACKAGE_LAYOUT.executionDirectory(admitted.value.identity));
        }
      }),
      fuzzParameters(),
    );
  });

  it('admits the frozen manifest and refuses it once any byte is truncated away', () => {
    assert.ok(readAdmittedExecution(MANIFEST_BYTES, validator).ok);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MANIFEST_BYTES.length - 2 }), (end) => {
        assert.equal(readAdmittedExecution(MANIFEST_BYTES.slice(0, end), validator).ok, false);
      }),
      fuzzParameters(),
    );
  });
});

describe('executionTargetsOf', () => {
  it('resolves any recorded outputs without throwing, consistently with the outputs it read', () => {
    fc.assert(
      fc.property(resourceManifest, (manifest) => {
        const targets = executionTargetsOf(manifest);
        assertBoundedRefusal(targets);
        if (!targets.ok) {
          return;
        }
        assert.equal(manifest.provisioning_status, 'succeeded');
        const values = new Set(manifest.outputs.map((entry) => entry.value));
        for (const queues of Object.values(targets.value.queues)) {
          for (const queue of [queues.source, queues.dlq]) {
            assert.ok(values.has(queue.queue_url));
            assert.ok(queue.queue_name !== '' && queue.queue_name === queueNameOf(queue.queue_url));
          }
        }
        const caller = targets.value.durable_caller;
        assert.ok(caller === undefined || values.has(`${caller.function_arn}:${caller.qualifier}`));
        assert.ok(targets.value.durable_function_names.every((name) => values.has(name)));
      }),
      fuzzParameters(),
    );
  });
});
