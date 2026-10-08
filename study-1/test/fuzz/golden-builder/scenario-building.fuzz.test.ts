// Properties of the golden scenario builder over its input space (testing rule 6): any trial plan
// either builds or is refused with exactly `checkTrialPlan`'s problems, never a throw; every plan
// the checks admit builds primary evidence that is schema-valid and internally consistent, whose
// runner assessment equals the §8.12 derivation from its own samples, and whose subject shows one
// provider call per planned attempt; scenario operations of any shape return a result; and the
// generator's comparison detects any single changed byte of a fixture.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { encodeFixtureBundle } from '../../../tools/golden/lib/fixture-bundle.ts';
import { compareFixture } from '../../../tools/golden/lib/fixture-generation.ts';
import type { FixtureDiscrepancy } from '../../../tools/golden/lib/fixture-generation.ts';
import { deriveSettlement, observeSubject, runnerEvents } from '../../golden/_harness/fixture-observations.ts';
import { expectedMismatches, fixtureRecords } from '../../golden/_harness/golden-harness.ts';
import type { LoadedGoldenCase } from '../../golden/_harness/golden-harness.ts';
import { applyByteOperations } from '../../support/golden-builder/byte-operations.ts';
import type { ByteOperation } from '../../support/golden-builder/byte-operations.ts';
import { serializeScenarioFiles } from '../../support/golden-builder/digest-links.ts';
import type { FixtureBytes } from '../../support/golden-builder/digest-links.ts';
import { fixtureIntegrityProblems } from '../../support/golden-builder/fixture-integrity.ts';
import { defineGoldenCase } from '../../support/golden-builder/golden-case.ts';
import { recordText } from '../../support/golden-builder/golden-event-log.ts';
import { ATTEMPT_BEHAVIORS, BASE_SCENARIOS, declaredTrialsOf } from '../../support/golden-builder/golden-plan.ts';
import type {
  AttemptBehavior,
  BaseScenarioId,
  PlanCaller,
  TrialPlan,
} from '../../support/golden-builder/golden-plan.ts';
import { MemoryFixtureFileSystem } from '../../support/golden-builder/memory-fixture-file-system.ts';
import { checkTrialPlan } from '../../support/golden-builder/plan-checks.ts';
import { buildBaseScenario } from '../../support/golden-builder/scenario-builder.ts';
import { applyModelOperations } from '../../support/golden-builder/scenario-operations.ts';
import type { ModelOperation } from '../../support/golden-builder/scenario-operations.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const validator = createRecordValidator();
// fast-check's own JSON type is structurally the kernel's; the assertion bridges the declarations.
const json: fc.Arbitrary<JsonValue> = fc.jsonValue().map((value) => value as JsonValue);

// The bases with at most two trials cover every caller and scenario at the lowest build cost.
const FUZZ_BASES = [
  'probe',
  'validation-conventional-control',
  'validation-conventional-treatment',
  'validation-durable-control',
  'validation-durable-treatment',
] as const satisfies readonly BaseScenarioId[];

function subjectOf(base: BaseScenarioId): {
  readonly caller: PlanCaller;
  readonly scenario: 'CONTROL' | 'COMMIT_THEN_TIMEOUT';
} {
  const shape = BASE_SCENARIOS[base];
  const declared = declaredTrialsOf(shape.execution)[shape.sequence - 1];
  return declared === undefined
    ? { caller: 'probe', scenario: 'COMMIT_THEN_TIMEOUT' }
    : { caller: declared.variant_id, scenario: declared.scenario };
}

const anyPlan: fc.Arbitrary<TrialPlan> = fc.record({
  deliveries: fc.array(
    fc.record({
      attempts: fc.array(
        fc.record(
          {
            behavior: fc.constantFrom(...ATTEMPT_BEHAVIORS),
            amount_minor: fc.oneof(fc.integer({ min: -2, max: 20_000 }), fc.constant(1.5)),
            currency: fc.constantFrom('BRL', 'USD', 'brl'),
            refund_request_id: fc.constantFrom('ref-poc-001', ' '),
            rejection_reason: fc.constantFrom('PAYMENT_NOT_FOUND', 'AMOUNT_INVALID'),
          },
          { requiredKeys: ['behavior'] },
        ),
        { maxLength: 3 },
      ),
    }),
    { maxLength: 3 },
  ),
  processing: fc.constantFrom('completes', 'active_at_deadline'),
});

// Plans shaped by the retry layers and targeting of the subject; the checks still decide.
function shapedPlan(caller: PlanCaller, scenario: 'CONTROL' | 'COMMIT_THEN_TIMEOUT'): fc.Arbitrary<TrialPlan> {
  const treatment = caller === 'probe' || scenario === 'COMMIT_THEN_TIMEOUT';
  const later = fc.constantFrom<AttemptBehavior>(
    'succeeded',
    'rejected',
    'commit_failed',
    ...(treatment ? [] : (['untargeted_timeout'] as const)),
  );
  const first = treatment ? fc.constantFrom<AttemptBehavior>('targeted_timeout', 'safety_release') : later;
  const perDelivery = caller === 'conventional' ? 1 : 2;
  const deliveries = caller === 'probe' ? 1 : 2;
  return fc
    .record({
      first,
      rest: fc.array(later, { maxLength: deliveries * perDelivery - 1 }),
      split: fc.integer({ min: 1, max: perDelivery }),
      processing: fc.constantFrom<TrialPlan['processing']>('completes', 'active_at_deadline'),
    })
    .map(({ first: head, rest, split, processing }) => {
      const behaviors = [head, ...rest];
      const cut = caller === 'conventional' ? 1 : Math.min(split, behaviors.length);
      const groups =
        caller === 'probe'
          ? [behaviors.slice(0, 2)]
          : [behaviors.slice(0, cut), behaviors.slice(cut)].filter((group) => group.length > 0);
      return { deliveries: groups.map((group) => ({ attempts: group.map((behavior) => ({ behavior })) })), processing };
    });
}

const admittedScenario = fc
  .constantFrom(...FUZZ_BASES)
  .chain((base) => {
    const { caller, scenario } = subjectOf(base);
    return shapedPlan(caller, scenario).map((plan) => ({ base, plan }));
  })
  .filter(({ base, plan }) => {
    const { caller, scenario } = subjectOf(base);
    return checkTrialPlan(caller, scenario, plan).length === 0;
  });

function loadedOf(base: BaseScenarioId, files: FixtureBytes, subjectDirectory: string): LoadedGoldenCase {
  return {
    golden_case: defineGoldenCase({ case_id: 'fuzz', ac_ids: [], rule_outcomes_reached: [], base, expected: null }),
    case_file: 'test/golden/fuzz/cases/fuzz.case.ts',
    fixture_file: 'test/golden/fuzz/fixtures/fuzz.fixture.json',
    files,
    subject_directory: subjectDirectory,
  };
}

const probeBuilt = buildBaseScenario('probe');
assert.ok(probeBuilt.ok);
const probeBytes = serializeScenarioFiles(probeBuilt.value.files);
assert.ok(probeBytes.ok);

describe('golden scenario builder fuzz', () => {
  it('builds a plan or refuses it with exactly the plan checks, never throwing', () => {
    fc.assert(
      fc.property(fc.constantFrom(...FUZZ_BASES), anyPlan, (base, plan) => {
        const { caller, scenario } = subjectOf(base);
        const problems = checkTrialPlan(caller, scenario, plan);
        const built = buildBaseScenario(base, plan);
        assert.deepEqual(built.ok ? [] : built.error, problems);
      }),
      fuzzParameters(),
    );
  });

  it('every admitted plan builds sound evidence that settles by §8.12 and shows each planned call', () => {
    fc.assert(
      fc.property(admittedScenario, ({ base, plan }) => {
        const built = buildBaseScenario(base, plan);
        assert.ok(built.ok);
        const bytes = serializeScenarioFiles(built.value.files);
        assert.ok(bytes.ok);
        const loaded = loadedOf(base, bytes.value, built.value.subject_directory);
        assert.deepEqual(fixtureIntegrityProblems(bytes.value, validator), []);
        const samples = fixtureRecords(bytes.value, `${loaded.subject_directory}/settlement/settlement-samples.jsonl`);
        const start =
          runnerEvents(loaded, 'trial_message_published')[0] ??
          fixtureRecords(bytes.value, `${loaded.subject_directory}/journals/caller-journal.jsonl`)[0];
        const deadline = Date.parse(start === undefined ? '' : recordText(start, 'occurred_at')) + 600_000;
        const assessed = runnerEvents(loaded, 'settlement_assessed').at(-1);
        assert.deepEqual(
          expectedMismatches({ ...deriveSettlement(samples, deadline), sample_count: samples.length }, assessed),
          [],
        );
        const attempts = plan.deliveries.reduce((total, delivery) => total + delivery.attempts.length, 0);
        assert.deepEqual(
          expectedMismatches({ configured_trace: { provider_calls: attempts } }, observeSubject(loaded)),
          [],
        );
      }),
      fuzzParameters(),
    );
  });

  it('scenario operations of any shape return a result instead of throwing', () => {
    const paths = fc.constantFrom(
      'probe/journals/caller-journal.jsonl',
      'probe/inputs/payment.json',
      '$trial/ledger/ledger-snapshot.json',
      'none.json',
      '../x',
      '',
    );
    const modelOperation: fc.Arbitrary<ModelOperation> = fc.oneof(
      fc.record(
        {
          op: fc.constant('set' as const),
          path: paths,
          pointer: fc.oneof(fc.constantFrom('/a', '/0', '/-', '/__proto__', ''), fc.string()),
          value: json,
          select: fc.oneof(
            fc.record({ line: fc.integer({ min: -1, max: 9 }) }),
            fc.record({ record_type: fc.string(), occurrence: fc.integer({ min: 1, max: 3 }) }),
          ),
        },
        { requiredKeys: ['op', 'path', 'pointer', 'value'] },
      ),
      fc.record({ op: fc.constant('remove' as const), path: paths, pointer: fc.string() }),
      fc.record({
        op: fc.constant('remove_record' as const),
        path: paths,
        select: fc.record({ event_id: fc.string() }),
      }),
      fc.record({ op: fc.constant('insert_record' as const), path: paths, record: json }),
      fc.record({
        op: fc.constant('clone_record' as const),
        path: paths,
        select: fc.record({ line: fc.integer({ min: 1, max: 9 }) }),
        set: fc.array(fc.record({ pointer: fc.string(), value: json }), { maxLength: 2 }),
      }),
      fc.record({ op: fc.constant('resequence' as const), path: paths }),
      fc.record({
        op: fc.constant('put_file' as const),
        path: paths,
        content: fc.record({ kind: fc.constant('json' as const), record: json }),
      }),
    );
    const byteOperation: fc.Arbitrary<ByteOperation> = fc.oneof(
      fc.record({ op: fc.constant('delete_file' as const), path: paths }),
      fc.record({
        op: fc.constant('corrupt_byte' as const),
        path: paths,
        offset: fc.integer({ min: -2, max: 5000 }),
        byte: fc.integer({ min: -1, max: 300 }),
      }),
      fc.record({ op: fc.constant('append_text' as const), path: paths, text: fc.string() }),
      fc.record({ op: fc.constant('truncate' as const), path: paths, length: fc.integer({ min: -1, max: 5000 }) }),
    );
    fc.assert(
      fc.property(
        fc.array(modelOperation, { maxLength: 4 }),
        fc.array(byteOperation, { maxLength: 4 }),
        (models, bytes) => {
          const edited = applyModelOperations(probeBuilt.value.files, models, 'probe');
          if (edited.ok) {
            const serialized = serializeScenarioFiles(edited.value);
            assert.equal(typeof serialized.ok, 'boolean');
          }
          const byteResult = applyByteOperations(probeBytes.value, bytes, 'probe');
          assert.equal(typeof byteResult.ok, 'boolean');
        },
      ),
      fuzzParameters(),
    );
  });

  describe('the fixture comparison', () => {
    const fixtureFile = 'test/golden/fuzz/fixtures/fuzz.fixture.json';
    const paths = [...probeBytes.value.keys()];
    const bundle = encodeFixtureBundle(probeBytes.value);
    const fixture = {
      case_file: 'test/golden/fuzz/cases/fuzz.case.ts',
      case_id: 'fuzz',
      fixture_file: fixtureFile,
      files: probeBytes.value,
      bundle,
    };
    const compared = (committed: Uint8Array): readonly FixtureDiscrepancy[] =>
      compareFixture(new MemoryFixtureFileSystem(new Map([[fixtureFile, committed]])), fixture);

    it('detects any single changed byte of the committed fixture file', () => {
      fc.assert(
        fc.property(fc.nat(), fc.integer({ min: 1, max: 255 }), (position, delta) => {
          const changed = Uint8Array.from(bundle);
          const offset = position % changed.length;
          changed[offset] = ((changed[offset] ?? 0) + delta) % 256;
          assert.notDeepEqual(compared(changed), []);
        }),
        fuzzParameters(),
      );
    });

    it('names the evidence file in which a single byte changed', () => {
      fc.assert(
        fc.property(fc.constantFrom(...paths), fc.nat(), fc.integer({ min: 1, max: 255 }), (path, position, delta) => {
          const changed = Uint8Array.from(probeBytes.value.get(path) ?? new Uint8Array());
          const offset = position % changed.length;
          changed[offset] = ((changed[offset] ?? 0) + delta) % 256;
          const edited = encodeFixtureBundle(new Map([...probeBytes.value, [path, changed]]));
          assert.deepEqual(compared(edited), [{ kind: 'different', path: `${fixtureFile}#${path}` }]);
        }),
        fuzzParameters(),
      );
    });
  });
});
