// Property tests of the transport probe's late-evidence inputs (testing rule 6; A-05 totality): the
// late stream bytes `readProbeLateStream` reads, and the frozen package files `frozenProbeEvidence`
// rebuilds the probe's frozen evidence from (the coordination prefix checkpoint, the runner journal
// and the resource manifest, all untrusted bytes). Over any bytes and near-valid lines each answers
// without throwing; every accepted record is a line of the stream with a route, every problem names
// the stream with a bounded detail, and a rebuilt frozen journal is always a prefix of the stored
// one. Runs FC_RUNS cases per property (10,000 under `npm run test:fuzz`).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { frozenProbeEvidence } from '../../../src/execution-lifecycle/frozen-probe-input.ts';
import { readProbeLateStream } from '../../../src/execution-lifecycle/probe-late-stream.ts';
import type { PackageFile } from '../../../src/evidence-package/package-file-system.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { canonicalJson } from '../../../src/record-contract/canonical-json.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { controllerCanaryAcknowledged } from '../../contract/record-contract/group-b/examples/controller-examples.ts';
import { ledgerSnapshot } from '../../contract/record-contract/group-b/examples/observation-examples.ts';
import { providerCallReceived } from '../../contract/record-contract/group-b/examples/provider-examples.ts';
import { ProbeRunnerWorld } from '../../integration/execution-lifecycle/support/probe-runner-world.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { towerText } from '../../support/kernel/deep-json.ts';
import type { TowerShape } from '../../support/kernel/deep-json.ts';
import {
  PROBE_CONTEXT,
  probeLateLine,
  probeScoped,
} from '../../unit/execution-lifecycle/support/probe-late-records.ts';

const MAX_DETAIL = 2_000;
const validator = createRecordValidator();
const encoder = new TextEncoder();
const INHERITED_NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];

const VALID_LINES: readonly JsonObject[] = [
  probeLateLine({ sequence: 1, late_source: 'PROVIDER_JOURNAL', late_record: probeScoped(providerCallReceived()) }),
  probeLateLine({ sequence: 1, late_source: 'LEDGER', late_record: probeScoped(ledgerSnapshot()) }),
  probeLateLine({
    sequence: 1,
    late_source: 'CONTROLLER_JOURNAL',
    late_record: probeScoped(controllerCanaryAcknowledged()),
    correlated: false,
  }),
];

const hostileLeaf: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.constantFrom<JsonValue>(-0, 2 ** 53, '', true, null, 'RUN', 'LEDGER', 'DLQ', 'ledger_snapshot'),
  fc.jsonValue({ maxDepth: 2 }) as fc.Arbitrary<JsonValue>,
);

// A valid line with one member, of the line or of the record it carries, replaced or removed.
const nearLine: fc.Arbitrary<JsonObject> = fc
  .record({
    line: fc.constantFrom(...VALID_LINES),
    carried: fc.boolean(),
    member: fc.oneof(
      fc.constantFrom(
        'sequence',
        'correlated',
        'late_source',
        'late_record_type',
        'late_record',
        'transport_probe_id',
        'execution_manifest_sha256',
        'trial_id',
        'run_id',
        'record_type',
        'causation_event_ids',
      ),
      fc.constantFrom(...INHERITED_NAMES),
    ),
    value: fc.option(hostileLeaf, { nil: undefined }),
  })
  .map(({ line, carried, member, value }) => {
    const target = carried ? (line['late_record'] as JsonObject) : line;
    const copy: Record<string, JsonValue> = Object.fromEntries(
      Object.entries(target).filter(([name]) => name !== member),
    );
    if (value !== undefined) {
      Object.defineProperty(copy, member, { value, enumerable: true, writable: true, configurable: true });
    }
    return carried ? { ...line, late_record: copy } : copy;
  });

// Lines renumbered densely or not, so both the accepted and the refused paths are reached.
const nearStream: fc.Arbitrary<Uint8Array> = fc
  .record({
    lines: fc.array(fc.oneof(fc.constantFrom(...VALID_LINES), nearLine), { maxLength: 6 }),
    dense: fc.boolean(),
    terminated: fc.boolean(),
  })
  .map(({ lines, dense, terminated }) => {
    const text = lines.map((line, index) => canonicalJson(dense ? { ...line, sequence: index + 1 } : line)).join('\n');
    return encoder.encode(terminated && text !== '' ? `${text}\n` : text);
  });

const anyStream: fc.Arbitrary<Uint8Array> = fc.oneof(
  { arbitrary: fc.uint8Array({ maxLength: 256 }), weight: 5 },
  {
    arbitrary: fc
      .array(fc.jsonValue() as fc.Arbitrary<JsonValue>, { maxLength: 4 })
      .map((values) => encoder.encode(values.map((value) => `${JSON.stringify(value)}\n`).join(''))),
    weight: 5,
  },
  { arbitrary: nearStream, weight: 20 },
  {
    arbitrary: fc
      .record({
        shape: fc.constantFrom<TowerShape>('array', 'object', 'mixed'),
        depth: fc.integer({ min: 1, max: 20_000 }),
      })
      .map(({ shape, depth }) => encoder.encode(`${towerText(shape, depth, '1')}\n`)),
    weight: 1,
  },
);

function lineCount(bytes: Uint8Array): number {
  return new TextDecoder()
    .decode(bytes)
    .split('\n')
    .filter((line) => line !== '').length;
}

describe('readProbeLateStream', () => {
  it('accepts the unmutated lines, so the near-valid streams reach the deep checks', () => {
    const text = VALID_LINES.map((line, index) => `${canonicalJson({ ...line, sequence: index + 1 })}\n`).join('');
    const reading = readProbeLateStream(
      { path: EXECUTION_PATHS.lateEvidenceStream, bytes: encoder.encode(text) },
      PROBE_CONTEXT,
      validator,
    );
    assert.deepEqual(reading.problems, []);
    assert.equal(reading.accepted.length, 2);
  });

  it('reads any stream without throwing; accepted lines are routed, problems are bounded', () => {
    fc.assert(
      fc.property(anyStream, (bytes) => {
        const reading = readProbeLateStream(
          { path: EXECUTION_PATHS.lateEvidenceStream, bytes },
          PROBE_CONTEXT,
          validator,
        );
        const lines = lineCount(bytes);
        assert.ok(reading.accepted.length <= lines);
        for (const accepted of reading.accepted) {
          assert.ok(accepted.line_number >= 1 && accepted.line_number <= lines);
          assert.equal(accepted.record.sequence, accepted.line_number);
          assert.equal(accepted.record.correlated, true);
          assert.equal(Object.hasOwn(accepted.record.late_record, 'trial_id'), false);
          assert.equal(validator.validate(accepted.record.late_record).valid, true);
        }
        for (const problem of reading.problems) {
          assert.equal(problem.artifact_path, EXECUTION_PATHS.lateEvidenceStream);
          assert.ok(problem.detail.length > 0 && problem.detail.length <= MAX_DETAIL, problem.detail);
        }
      }),
      fuzzParameters(),
    );
  });
});

const world = await ProbeRunnerWorld.create();
assert.equal((await world.run()).package_finalized, true);
const FILES: readonly PackageFile[] = [...world.cloud.packageFiles()].map(([path, bytes]) => ({ path, bytes }));
const RUNNER = world.file(EXECUTION_PATHS.runnerJournal) ?? new Uint8Array();
const COORDINATION = world.file(EXECUTION_PATHS.coordinationJournal) ?? new Uint8Array();
const REPLACEABLE = [
  EXECUTION_PATHS.coordinationPrefixCheckpoint,
  EXECUTION_PATHS.runnerJournal,
  EXECUTION_PATHS.resourceManifest,
] as const;

// The stored bytes cut, extended or replaced, so readable variants reach the deeper paths.
const storedVariant: fc.Arbitrary<Uint8Array | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.uint8Array({ maxLength: 128 }),
  (fc.jsonValue() as fc.Arbitrary<JsonValue>).map((value) => encoder.encode(`${JSON.stringify(value)}\n`)),
  fc
    .record({ count: fc.oneof(fc.integer(), fc.double(), fc.constant(COORDINATION.length)) })
    .map(({ count }) => encoder.encode(`{"prefix_byte_count":${JSON.stringify(count)}}\n`)),
  fc.integer({ min: 0, max: RUNNER.length }).map((end) => RUNNER.slice(0, end)),
);

describe('frozenProbeEvidence', () => {
  it('rebuilds the stored package, so the variants start from a readable one', () => {
    const rebuilt = frozenProbeEvidence(FILES, world.admitted, validator);
    assert.ok(rebuilt.ok && rebuilt.value !== undefined);
  });

  it('rebuilds from any stored checkpoint, runner journal or resource manifest without throwing', () => {
    fc.assert(
      fc.property(fc.constantFrom(...REPLACEABLE), storedVariant, (path, bytes) => {
        const files = [
          ...FILES.filter((file) => file.path !== path),
          ...(bytes === undefined ? [] : [{ path, bytes }]),
        ];
        const stored = new Map(files.map((file) => [file.path, file.bytes]));
        const rebuilt = frozenProbeEvidence(files, world.admitted, validator);
        if (!rebuilt.ok) {
          assert.equal(rebuilt.error.code, 'FROZEN_PROBE_INPUT_UNREADABLE');
          assert.ok(rebuilt.error.detail.length <= MAX_DETAIL, rebuilt.error.detail);
          return;
        }
        assert.ok(rebuilt.value !== undefined);
        for (const artifact of rebuilt.value.frozen.artifacts) {
          const whole = stored.get(artifact.path) ?? new Uint8Array();
          assert.ok(artifact.bytes.length <= whole.length);
          assert.deepEqual(artifact.bytes, whole.subarray(0, artifact.bytes.length), `${artifact.path} is a prefix`);
        }
      }),
      fuzzParameters(),
    );
  });
});
