// Property-based tests of the §9.11 decision table (testing rule 6: a protocol/state-machine
// transition over a broad input space; BR-RUA-025). Over near-valid caller events, every
// treatment state, both scenarios and the canary: the decision is total, and the controller
// signals exactly when the event is a valid caller timeout of the partition, the scenario arms
// treatment, the treatment is COMMITTED_WAITING and the event names the targeted attempt. A
// signal's causation is the sorted pair of the commit event and the caller event.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { JsonObject, JsonValue, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { experimentExpectation, readCallerTimeout } from '../../../src/treatment-controller/caller-timeout-event.ts';
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
  PROBE,
  PROBE_ID,
  PROVIDER_COMMIT_ID,
  RUN_ID,
  callerTimeoutImage,
} from '../../unit/treatment-controller/support/controller-fixtures.ts';

const LOW_COMMIT_EVENT_ID = '00000000-0000-4000-8000-000000000001' as Uuid4;

const configuration = (scenario: 'CONTROL' | 'COMMIT_THEN_TIMEOUT'): ControllerConfigView => ({
  execution_manifest_sha256: MANIFEST_SHA,
  registered_caller_id: 'probe',
  scenario,
});

// Weighted toward the armed partition and the committed wait, so signals are common enough for
// the equivalence below to be exercised on both sides even at small budgets.
const context: fc.Arbitrary<SignalContext> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.constant<SignalContext>({
      kind: 'experiment',
      deployment: PROBE,
      configuration: configuration('COMMIT_THEN_TIMEOUT'),
    }),
  },
  fc.constant<SignalContext>({ kind: 'experiment', deployment: PROBE, configuration: configuration('CONTROL') }),
  fc.constant<SignalContext>({ kind: 'canary', deployment: PROBE }),
);

const uuidLike = fc.oneof(
  fc.constantFrom<JsonValue>(ATTEMPT_ID, OTHER_ATTEMPT_ID, CALLER_EVENT_ID, OTHER_CALLER_EVENT_ID, RUN_ID, PROBE_ID),
  fc.uuid({ version: 4 }),
  fc.constantFrom<JsonValue>(ATTEMPT_ID.toUpperCase(), 'aaaaaaaa-0000-1000-8000-000000000001', '', null, 7),
);

const fieldMutation: fc.Arbitrary<readonly [string, JsonValue | undefined]> = fc.oneof(
  fc.tuple(fc.constantFrom('attempt_id', 'event_id'), fc.option(uuidLike, { nil: undefined, freq: 6 })),
  fc.tuple(
    fc.constantFrom('record_type', 'schema_version', 'source', 'execution_manifest_sha256'),
    fc.option(
      fc.constantFrom<JsonValue>(
        'caller_timeout_recorded',
        'dispatch_started',
        1,
        2,
        'probe_caller',
        'runner',
        'conventional_caller',
        MANIFEST_SHA,
        OTHER_SHA,
      ),
      { nil: undefined, freq: 6 },
    ),
  ),
  fc.tuple(fc.constantFrom('transport_probe_id', 'run_id', 'trial_id'), fc.option(uuidLike, { nil: undefined })),
);

const callerEvent: fc.Arbitrary<JsonValue> = fc.oneof(
  { weight: 4, arbitrary: fc.constant<JsonValue>(callerTimeoutImage('probe')) },
  {
    weight: 8,
    arbitrary: fc
      .tuple(fc.constant(callerTimeoutImage('probe')), fc.array(fieldMutation, { maxLength: 2 }))
      .map(mutated),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(fc.constant(callerTimeoutImage('canary')), fc.array(fieldMutation, { maxLength: 2 }))
      .map(mutated),
  },
  { weight: 1, arbitrary: fc.jsonValue({ maxDepth: 2 }) as fc.Arbitrary<JsonValue> },
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

const commit = fc.record({
  targeted_attempt_id: fc.constantFrom(ATTEMPT_ID, OTHER_ATTEMPT_ID),
  provider_commit_id: fc.constant(PROVIDER_COMMIT_ID),
  commit_event_id: fc.constantFrom(COMMIT_EVENT_ID, LOW_COMMIT_EVENT_ID),
});

const treatment: fc.Arbitrary<ControllerTreatment | undefined> = fc.oneof(
  fc.constantFrom<ControllerTreatment | undefined>({ state: 'ARMED' }, { state: 'SAFETY_RELEASED' }, undefined),
  {
    weight: 3,
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

function signalExpected(
  event: JsonValue,
  decisionContext: SignalContext,
  current: ControllerTreatment | undefined,
): boolean {
  if (decisionContext.kind === 'canary' || decisionContext.configuration.scenario !== 'COMMIT_THEN_TIMEOUT') {
    return false;
  }
  const read = readCallerTimeout(
    event,
    experimentExpectation(decisionContext.deployment, decisionContext.configuration),
  );
  return read.ok && current?.state === 'COMMITTED_WAITING' && read.value.attempt_id === current.targeted_attempt_id;
}

describe('controller decision properties', () => {
  it('decides any event against any treatment without throwing', () => {
    fc.assert(
      fc.property(
        fc.oneof(callerEvent, fc.jsonValue() as fc.Arbitrary<JsonValue>),
        context,
        treatment,
        (event, where, current) => {
          const decision = decideSignal(event, where, current);
          assert.equal(typeof decision.kind, 'string');
        },
      ),
      fuzzParameters(),
    );
  });

  it('signals exactly a valid, targeted caller timeout against COMMITTED_WAITING in an armed partition', () => {
    // Both sides of the equivalence must be exercised, or the property is vacuous.
    const seen = { signal: 0, other: 0 };
    fc.assert(
      fc.property(callerEvent, context, treatment, (event, where, current) => {
        const decision = decideSignal(event, where, current);
        seen[decision.kind === 'signal' ? 'signal' : 'other'] += 1;
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
    assert.ok(seen.signal > 0 && seen.other > 0, JSON.stringify(seen));
  });

  it('never acts on treatment from the canary, a CONTROL partition or a non-waiting state', () => {
    fc.assert(
      fc.property(callerEvent, context, treatment, (event, where, current) => {
        const decision = decideSignal(event, where, current);
        if (where.kind === 'canary') {
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
