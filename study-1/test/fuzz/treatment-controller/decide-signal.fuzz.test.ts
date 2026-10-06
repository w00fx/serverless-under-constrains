// Property-based tests of the §9.11 decision table (testing rule 6: a protocol/state-machine
// transition over a broad input space; BR-RUA-025). Over near-valid caller events, every
// treatment state, both scenarios, probe and trial partitions of every execution kind, and the
// canary: the decision is total, and the controller signals exactly when the event is a valid
// caller timeout of the partition, the scenario arms treatment, the treatment is
// COMMITTED_WAITING and the event names the targeted attempt. A signal's causation is the sorted
// pair of the commit event and the caller event.
//
// The oracle of "valid caller timeout of the partition" is independent of the controller's own
// validator (review r1): schema validity comes from the catalogue's Ajv validator, and the
// partition identity (execution, manifest, trial, source) is restated field by field from
// design §9.3, §9.11, D-06 and D-10.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { ExecutionIdentity, JsonObject, JsonValue, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { isJsonObject } from '../../../src/record-contract/json-value.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import type {
  ControllerConfigView,
  ControllerTreatment,
} from '../../../src/treatment-controller/controller-control-items.ts';
import { decideSignal } from '../../../src/treatment-controller/signal-decision.ts';
import type { SignalContext } from '../../../src/treatment-controller/signal-decision.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import {
  ATTEMPT_ID,
  CALLER_EVENT_ID,
  COMMIT_EVENT_ID,
  MANIFEST_SHA,
  OTHER_ATTEMPT_ID,
  OTHER_CALLER_EVENT_ID,
  OTHER_SHA,
  OTHER_TRIAL_ID,
  PROBE,
  PROBE_ID,
  PROVIDER_COMMIT_ID,
  RUN,
  RUN_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  VALIDATION,
  VALIDATION_ID,
  callerTimeoutImage,
} from '../../unit/treatment-controller/support/controller-fixtures.ts';

const LOW_COMMIT_EVENT_ID = '00000000-0000-4000-8000-000000000001' as Uuid4;
const validator = createRecordValidator();

const TRIAL = { trial_id: TRIAL_ID, trial_manifest_sha256: TRIAL_MANIFEST_SHA };

const probeConfiguration = (scenario: 'CONTROL' | 'COMMIT_THEN_TIMEOUT'): ControllerConfigView => ({
  execution_manifest_sha256: MANIFEST_SHA,
  registered_caller_id: 'probe',
  scenario,
});
const trialConfiguration = (
  scenario: 'CONTROL' | 'COMMIT_THEN_TIMEOUT',
  caller: 'conventional' | 'durable',
): ControllerConfigView => ({
  execution_manifest_sha256: MANIFEST_SHA,
  registered_caller_id: caller,
  scenario,
  trial: TRIAL,
});

// Weighted toward armed partitions, so signals are common enough for the equivalence below to be
// exercised on both sides even at small budgets.
const context: fc.Arbitrary<SignalContext> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.constant<SignalContext>({
      kind: 'experiment',
      deployment: PROBE,
      configuration: probeConfiguration('COMMIT_THEN_TIMEOUT'),
    }),
  },
  {
    weight: 5,
    arbitrary: fc
      .tuple(fc.constantFrom(RUN, VALIDATION), fc.constantFrom('conventional', 'durable' as const))
      .map(([deployment, caller]): SignalContext => ({
        kind: 'experiment',
        deployment,
        configuration: trialConfiguration('COMMIT_THEN_TIMEOUT', caller),
      })),
  },
  fc.constant<SignalContext>({ kind: 'experiment', deployment: PROBE, configuration: probeConfiguration('CONTROL') }),
  fc.constant<SignalContext>({
    kind: 'experiment',
    deployment: RUN,
    configuration: trialConfiguration('CONTROL', 'conventional'),
  }),
  fc.constantFrom<SignalContext>(
    { kind: 'canary', deployment: PROBE },
    { kind: 'canary', deployment: RUN },
    { kind: 'canary', deployment: VALIDATION },
  ),
);

// The valid caller timeout of a context, as its writer would store it.
function matchingImage(where: SignalContext): JsonObject {
  if (where.kind === 'canary') {
    return withIdentity(callerTimeoutImage('canary'), where.deployment);
  }
  if (where.configuration.trial === undefined) {
    return callerTimeoutImage('probe');
  }
  const image = callerTimeoutImage('trial', { source: `${where.configuration.registered_caller_id}_caller` });
  return withIdentity(image, where.deployment);
}

function withIdentity(image: JsonObject, deployment: ExecutionIdentity): JsonObject {
  const { run_id: _run, transport_probe_id: _probe, variant_validation_id: _validation, ...rest } = image;
  return { ...rest, ...identityOf(deployment) };
}

function identityOf(deployment: ExecutionIdentity): JsonObject {
  switch (deployment.execution_kind) {
    case 'RUN':
      return { run_id: deployment.run_id };
    case 'TRANSPORT_PROBE':
      return { transport_probe_id: deployment.transport_probe_id };
    case 'VARIANT_VALIDATION':
      return { variant_validation_id: deployment.variant_validation_id };
  }
}

const uuidLike = fc.oneof(
  fc.constantFrom<JsonValue>(
    ATTEMPT_ID,
    OTHER_ATTEMPT_ID,
    CALLER_EVENT_ID,
    OTHER_CALLER_EVENT_ID,
    RUN_ID,
    PROBE_ID,
    VALIDATION_ID,
    TRIAL_ID,
    OTHER_TRIAL_ID,
  ),
  fc.uuid({ version: 4 }),
  fc.constantFrom<JsonValue>(ATTEMPT_ID.toUpperCase(), 'aaaaaaaa-0000-1000-8000-000000000001', '', null, 7),
);

const fieldMutation: fc.Arbitrary<readonly [string, JsonValue | undefined]> = fc.oneof(
  fc.tuple(fc.constantFrom('attempt_id', 'event_id'), fc.option(uuidLike, { nil: undefined, freq: 6 })),
  fc.tuple(
    fc.constantFrom('record_type', 'schema_version', 'source', 'execution_manifest_sha256', 'trial_manifest_sha256'),
    fc.option(
      fc.constantFrom<JsonValue>(
        'caller_timeout_recorded',
        'dispatch_started',
        1,
        2,
        'probe_caller',
        'runner',
        'conventional_caller',
        'durable_caller',
        MANIFEST_SHA,
        TRIAL_MANIFEST_SHA,
        OTHER_SHA,
      ),
      { nil: undefined, freq: 6 },
    ),
  ),
  fc.tuple(
    fc.constantFrom('transport_probe_id', 'run_id', 'variant_validation_id', 'trial_id'),
    fc.option(uuidLike, { nil: undefined }),
  ),
  fc.tuple(
    fc.constantFrom('elapsed_ns', 'timer_fired_at', 'recorded_at', 'causation_event_ids', 'arbiter_winner', 'extra'),
    fc.option(
      fc.constantFrom<JsonValue>(
        '3000000000',
        '12',
        '03',
        3000000000,
        '2026-10-05T12:00:03.000Z',
        '2026-02-30T12:00:03.000Z',
        [CALLER_EVENT_ID],
        [OTHER_CALLER_EVENT_ID, CALLER_EVENT_ID],
        [],
        'TIMER',
        'TRANSPORT',
        'timer',
      ),
      { nil: undefined, freq: 6 },
    ),
  ),
);

function mutated([base, mutations]: readonly [
  JsonObject,
  readonly (readonly [string, JsonValue | undefined])[],
]): JsonValue {
  const event: Record<string, JsonValue> = { ...base };
  for (const [field, value] of mutations) {
    if (value === undefined) {
      Reflect.deleteProperty(event, field);
      continue;
    }
    event[field] = value;
  }
  return event;
}

// A context and an event: mostly its own valid image, mutated or not, sometimes another
// partition's image or any JSON value.
const decisionInput: fc.Arbitrary<readonly [JsonValue, SignalContext]> = context.chain((where) => {
  const own = matchingImage(where);
  const event: fc.Arbitrary<JsonValue> = fc.oneof(
    { weight: 8, arbitrary: fc.constant<JsonValue>(own) },
    { weight: 8, arbitrary: fc.tuple(fc.constant(own), fc.array(fieldMutation, { maxLength: 2 })).map(mutated) },
    {
      weight: 2,
      arbitrary: fc
        .tuple(
          fc.constantFrom(callerTimeoutImage('canary'), callerTimeoutImage('probe'), callerTimeoutImage('trial')),
          fc.array(fieldMutation, { maxLength: 2 }),
        )
        .map(mutated),
    },
    { weight: 1, arbitrary: fc.jsonValue({ maxDepth: 2 }) as fc.Arbitrary<JsonValue> },
  );
  return event.map((value) => [value, where] as const);
});

const commit = fc.record({
  targeted_attempt_id: fc.oneof({ weight: 4, arbitrary: fc.constant(ATTEMPT_ID) }, fc.constant(OTHER_ATTEMPT_ID)),
  provider_commit_id: fc.constant(PROVIDER_COMMIT_ID),
  commit_event_id: fc.constantFrom(COMMIT_EVENT_ID, LOW_COMMIT_EVENT_ID),
});

const treatment: fc.Arbitrary<ControllerTreatment | undefined> = fc.oneof(
  fc.constantFrom<ControllerTreatment | undefined>({ state: 'ARMED' }, { state: 'SAFETY_RELEASED' }, undefined),
  {
    weight: 8,
    arbitrary: commit.map((value): ControllerTreatment => ({ state: 'COMMITTED_WAITING', ...value })),
  },
  fc
    .tuple(
      fc.constantFrom('TIMEOUT_SIGNALLED', 'TIMEOUT_OBSERVED', 'RESPONSE_RELEASED' as const),
      commit,
      fc.constantFrom(CALLER_EVENT_ID, OTHER_CALLER_EVENT_ID),
    )
    .map(([state, value, signaller]): ControllerTreatment => ({ state, ...value, signal_caller_event_id: signaller })),
);

const IDENTITY_FIELDS = ['run_id', 'transport_probe_id', 'variant_validation_id'];

// Independent restatement of "a valid caller timeout of this partition".
function validForPartition(event: JsonValue, where: SignalContext): event is JsonObject {
  if (!isJsonObject(event)) {
    return false;
  }
  const { pk: _pk, sk: _sk, ...record } = event;
  if (!validator.validateAs('caller_timeout_recorded', record).valid) {
    return false;
  }
  const identity = identityOf(where.deployment);
  const identityHolds = IDENTITY_FIELDS.every((field) => record[field] === identity[field]);
  if (where.kind === 'canary') {
    return identityHolds && record['trial_id'] === undefined && record['source'] === 'runner';
  }
  const { configuration } = where;
  const trialHolds =
    configuration.trial === undefined
      ? record['trial_id'] === undefined
      : record['trial_id'] === configuration.trial.trial_id &&
        record['trial_manifest_sha256'] === configuration.trial.trial_manifest_sha256;
  return (
    identityHolds &&
    trialHolds &&
    record['execution_manifest_sha256'] === configuration.execution_manifest_sha256 &&
    record['source'] === `${configuration.registered_caller_id}_caller`
  );
}

function signalExpected(event: JsonValue, where: SignalContext, current: ControllerTreatment | undefined): boolean {
  if (where.kind === 'canary' || where.configuration.scenario !== 'COMMIT_THEN_TIMEOUT') {
    return false;
  }
  return (
    validForPartition(event, where) &&
    current?.state === 'COMMITTED_WAITING' &&
    event['attempt_id'] === current.targeted_attempt_id
  );
}

describe('controller decision properties', () => {
  it('decides any event against any treatment without throwing', () => {
    fc.assert(
      fc.property(
        fc.oneof(decisionInput, fc.tuple(fc.jsonValue() as fc.Arbitrary<JsonValue>, context)),
        treatment,
        ([event, where], current) => {
          const decision = decideSignal(event, where, current);
          assert.equal(typeof decision.kind, 'string');
        },
      ),
      fuzzParameters(),
    );
  });

  it('signals exactly a valid, targeted caller timeout against COMMITTED_WAITING in an armed partition', () => {
    // Both sides, and signals in probe and in trial partitions, or the property is vacuous.
    const seen = { probe_signal: 0, trial_signal: 0, other: 0 };
    fc.assert(
      fc.property(decisionInput, treatment, ([event, where], current) => {
        const decision = decideSignal(event, where, current);
        const trialPartition = where.kind === 'experiment' && where.configuration.trial !== undefined;
        seen[decision.kind !== 'signal' ? 'other' : trialPartition ? 'trial_signal' : 'probe_signal'] += 1;
        assert.equal(
          decision.kind === 'signal',
          signalExpected(event, where, current),
          JSON.stringify({ event, where, current }),
        );
        if (decision.kind !== 'signal' || current?.state !== 'COMMITTED_WAITING') {
          return;
        }
        const pair = [current.commit_event_id, decision.caller_timeout_event_id].toSorted();
        assert.deepEqual(decision.causation, pair);
        assert.equal(decision.attempt_id, current.targeted_attempt_id);
        assert.equal(decision.provider_commit_id, current.provider_commit_id);
      }),
      fuzzParameters(),
    );
    assert.ok(seen.probe_signal > 0 && seen.trial_signal > 0 && seen.other > 0, JSON.stringify(seen));
  });

  it('never acts on treatment from the canary, a CONTROL partition or a non-waiting state', () => {
    fc.assert(
      fc.property(decisionInput, treatment, ([event, where], current) => {
        const decision = decideSignal(event, where, current);
        if (where.kind === 'canary') {
          // The canary acknowledges exactly a valid runner canary of this deployment (D-10).
          assert.equal(decision.kind === 'canary_acknowledged', validForPartition(event, where));
          assert.ok(['canary_acknowledged', 'invalid_event_rejected'].includes(decision.kind), decision.kind);
          return;
        }
        if (where.configuration.scenario === 'CONTROL') {
          assert.ok(['control_trial_rejected', 'invalid_event_rejected'].includes(decision.kind), decision.kind);
          return;
        }
        if (current?.state !== 'COMMITTED_WAITING') {
          assert.notEqual(decision.kind, 'signal');
        }
      }),
      fuzzParameters(),
    );
  });
});
