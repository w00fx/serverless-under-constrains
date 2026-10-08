// The controller's validation of an inserted caller timeout (BR-RUA-025, design §9.11 "invalid
// event, or identity mismatch"; D-10 canary written by the runner).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import {
  canaryExpectation,
  experimentExpectation,
  readCallerTimeout,
} from '../../../src/treatment-controller/caller-timeout-event.ts';
import type { ControllerConfigView } from '../../../src/treatment-controller/controller-control-items.ts';
import {
  ATTEMPT_ID,
  CALLER_EVENT_ID,
  MANIFEST_SHA,
  OTHER_RUN_ID,
  OTHER_SHA,
  OTHER_TRIAL_ID,
  PROBE,
  PROBE_ID,
  RUN,
  RUN_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  callerTimeoutImage,
} from './support/controller-fixtures.ts';
import {
  DESCRIBED_DEEP_ARRAYS,
  DESCRIBED_DEEP_OBJECTS,
  HOSTILE_DEPTH,
  nestedArrays,
  nestedObjects,
} from '../../support/transport-rehearsal/deep-values.ts';

const TRIAL_CONFIG: ControllerConfigView = {
  execution_manifest_sha256: MANIFEST_SHA,
  registered_caller_id: 'conventional',
  scenario: 'COMMIT_THEN_TIMEOUT',
  trial: { trial_id: TRIAL_ID, trial_manifest_sha256: TRIAL_MANIFEST_SHA },
};
const PROBE_CONFIG: ControllerConfigView = {
  execution_manifest_sha256: MANIFEST_SHA,
  registered_caller_id: 'probe',
  scenario: 'COMMIT_THEN_TIMEOUT',
};
const VALID = { ok: true, value: { event_id: CALLER_EVENT_ID, attempt_id: ATTEMPT_ID } } as const;
const IDS = { caller_timeout_event_id: CALLER_EVENT_ID, attempt_id: ATTEMPT_ID } as const;

function rejected(detail: string, ids: object = IDS): object {
  return { ok: false, error: { detail, ...ids } };
}

describe('caller timeout expectations', () => {
  it('expects the registered caller in an experiment partition and the runner in the canary', () => {
    assert.deepEqual(experimentExpectation(RUN, TRIAL_CONFIG), {
      deployment: RUN,
      execution_manifest_sha256: MANIFEST_SHA,
      trial: TRIAL_CONFIG.trial,
      source: 'conventional_caller',
    });
    assert.equal(experimentExpectation(PROBE, PROBE_CONFIG).source, 'probe_caller');
    assert.deepEqual(canaryExpectation(PROBE), {
      deployment: PROBE,
      execution_manifest_sha256: undefined,
      trial: undefined,
      source: 'runner',
    });
  });
});

describe('readCallerTimeout', () => {
  it('reads the event and attempt of a valid trial, probe or canary event', () => {
    assert.deepEqual(readCallerTimeout(callerTimeoutImage('trial'), experimentExpectation(RUN, TRIAL_CONFIG)), VALID);
    assert.deepEqual(readCallerTimeout(callerTimeoutImage('probe'), experimentExpectation(PROBE, PROBE_CONFIG)), VALID);
    assert.deepEqual(readCallerTimeout(callerTimeoutImage('canary'), canaryExpectation(PROBE)), VALID);
    const otherDigest = callerTimeoutImage('canary', { execution_manifest_sha256: OTHER_SHA });
    assert.deepEqual(readCallerTimeout(otherDigest, canaryExpectation(PROBE)), VALID);
  });

  it('refuses a value that is not an object, without identities', () => {
    for (const value of [null, 'caller_timeout_recorded', [1]] as readonly JsonValue[]) {
      const result = readCallerTimeout(value, canaryExpectation(PROBE));
      assert.equal(result.ok, false);
      assert.deepEqual(Object.keys(result.error), ['detail']);
    }
    assert.deepEqual(
      readCallerTimeout(null, canaryExpectation(PROBE)),
      rejected('stream image is null null; expected a JSON object', {}),
    );
  });

  it('refuses another record type or schema version', () => {
    const expected = experimentExpectation(RUN, TRIAL_CONFIG);
    assert.deepEqual(
      readCallerTimeout(callerTimeoutImage('trial', { record_type: 'dispatch_started' }), expected),
      rejected(
        'record_type string "dispatch_started" schema_version number 1; expected caller_timeout_recorded version 1',
      ),
    );
    assert.deepEqual(
      readCallerTimeout(callerTimeoutImage('trial', { schema_version: 2 }), expected),
      rejected(
        'record_type string "caller_timeout_recorded" schema_version number 2; expected caller_timeout_recorded version 1',
      ),
    );
  });

  it('refuses an execution identity other than exactly this deployment', () => {
    const expected = experimentExpectation(RUN, TRIAL_CONFIG);
    assert.deepEqual(
      readCallerTimeout(callerTimeoutImage('trial', { run_id: OTHER_RUN_ID }), expected),
      rejected(`execution identity [run_id=string "${OTHER_RUN_ID}"]; expected only run_id=${RUN_ID}`),
    );
    assert.deepEqual(
      readCallerTimeout(callerTimeoutImage('trial', { transport_probe_id: PROBE_ID }), expected),
      rejected(
        `execution identity [run_id=string "${RUN_ID}", transport_probe_id=string "${PROBE_ID}"]; expected only run_id=${RUN_ID}`,
      ),
    );
    const { run_id: _dropped, ...withoutRun } = callerTimeoutImage('trial');
    assert.deepEqual(
      readCallerTimeout(withoutRun, expected),
      rejected(`execution identity []; expected only run_id=${RUN_ID}`),
    );
  });

  it('refuses a manifest digest other than the configured one, or a malformed canary digest', () => {
    assert.deepEqual(
      readCallerTimeout(
        callerTimeoutImage('trial', { execution_manifest_sha256: OTHER_SHA }),
        experimentExpectation(RUN, TRIAL_CONFIG),
      ),
      rejected(`execution_manifest_sha256 string "${OTHER_SHA}"; expected ${MANIFEST_SHA}`),
    );
    assert.deepEqual(
      readCallerTimeout(callerTimeoutImage('canary', { execution_manifest_sha256: 'abc' }), canaryExpectation(PROBE)),
      rejected('execution_manifest_sha256 string "abc"; expected 64 lowercase hex digits'),
    );
  });

  it('refuses a trial identity other than the partition trial, and any trial identity elsewhere', () => {
    assert.deepEqual(
      readCallerTimeout(
        callerTimeoutImage('trial', { trial_id: OTHER_TRIAL_ID }),
        experimentExpectation(RUN, TRIAL_CONFIG),
      ),
      rejected(
        `trial_id string "${OTHER_TRIAL_ID}" trial_manifest_sha256 string "${TRIAL_MANIFEST_SHA}"; expected trial ${TRIAL_ID} with manifest ${TRIAL_MANIFEST_SHA}`,
      ),
    );
    assert.deepEqual(
      readCallerTimeout(
        callerTimeoutImage('trial', { trial_manifest_sha256: OTHER_SHA }),
        experimentExpectation(RUN, TRIAL_CONFIG),
      ),
      rejected(
        `trial_id string "${TRIAL_ID}" trial_manifest_sha256 string "${OTHER_SHA}"; expected trial ${TRIAL_ID} with manifest ${TRIAL_MANIFEST_SHA}`,
      ),
    );
    for (const extra of [{ trial_id: TRIAL_ID }, { trial_manifest_sha256: TRIAL_MANIFEST_SHA }]) {
      const result = readCallerTimeout(callerTimeoutImage('probe', extra), experimentExpectation(PROBE, PROBE_CONFIG));
      assert.equal(result.ok, false);
      assert.match(result.error.detail, /; expected no trial identity$/);
    }
  });

  it('refuses a source other than the registered caller or, in the canary, the runner', () => {
    assert.deepEqual(
      readCallerTimeout(
        callerTimeoutImage('trial', { source: 'durable_caller' }),
        experimentExpectation(RUN, TRIAL_CONFIG),
      ),
      rejected('source string "durable_caller"; expected conventional_caller'),
    );
    assert.deepEqual(
      readCallerTimeout(callerTimeoutImage('canary', { source: 'probe_caller' }), canaryExpectation(PROBE)),
      rejected('source string "probe_caller"; expected runner'),
    );
  });

  it('refuses malformed event or attempt ids and keeps whichever id is readable', () => {
    const expected = experimentExpectation(PROBE, PROBE_CONFIG);
    assert.deepEqual(
      readCallerTimeout(callerTimeoutImage('probe', { attempt_id: 'ATTEMPT' }), expected),
      rejected(
        `event_id string "${CALLER_EVENT_ID}" and attempt_id string "ATTEMPT"; expected lowercase RFC 4122 version-4 UUIDs`,
        { caller_timeout_event_id: CALLER_EVENT_ID },
      ),
    );
    assert.deepEqual(
      readCallerTimeout(callerTimeoutImage('probe', { event_id: 7 }), expected),
      rejected(`event_id number 7 and attempt_id string "${ATTEMPT_ID}"; expected lowercase RFC 4122 version-4 UUIDs`, {
        attempt_id: ATTEMPT_ID,
      }),
    );
  });
});

function without(image: JsonObject, field: string): JsonObject {
  const { [field]: _removed, ...rest } = image;
  return rest;
}

describe('readCallerTimeout record shape (design §9.11 "invalid event"; BR-RUA-023 fields)', () => {
  const expected = experimentExpectation(PROBE, PROBE_CONFIG);
  const UUID = 'a lowercase RFC 4122 version-4 UUID';
  const UTC = 'a UTC timestamp YYYY-MM-DDTHH:mm:ss.SSSZ';
  // Each required field, a malformed value, how it is described and the shape it must have.
  const FIELDS: readonly (readonly [string, JsonValue, string, string])[] = [
    ['occurred_at', '2026-02-30T00:00:00.000Z', 'string "2026-02-30T00:00:00.000Z"', UTC],
    ['source_instance_id', 'x', 'string "x"', UUID],
    ['source_sequence', 0, 'number 0', 'a safe integer >= 1'],
    ['causation_event_ids', [], 'array []', 'a non-empty ascending list of distinct lowercase UUIDv4s'],
    ['provider_request_id', 1, 'number 1', UUID],
    ['refund_request_id', ' r', 'string " r"', 'a non-empty string without edge whitespace'],
    ['elapsed_ns', '03000000000', 'string "03000000000"', 'a decimal string of nanoseconds without leading zeros'],
    ['monotonic_origin_event_id', null, 'null null', UUID],
    ['dispatch_at', '2026-10-05T12:00:00Z', 'string "2026-10-05T12:00:00Z"', UTC],
    ['deadline_at', 3, 'number 3', UTC],
    ['timer_fired_at', '', 'string ""', UTC],
    ['abort_requested_at', true, 'boolean true', UTC],
    ['recorded_at', '2026-10-05 12:00:03.000Z', 'string "2026-10-05 12:00:03.000Z"', UTC],
    ['arbiter_winner', 'timer', 'string "timer"', 'TIMER or TRANSPORT'],
    ['transport_settled_at_claim', 'false', 'string "false"', 'a boolean'],
  ];

  it('refuses each required BR-RUA-023 or envelope field when absent or malformed', () => {
    for (const [field, value, described, shape] of FIELDS) {
      assert.deepEqual(
        readCallerTimeout(without(callerTimeoutImage('probe'), field), expected),
        rejected(`${field} absent; expected ${shape}`),
        `${field} absent`,
      );
      assert.deepEqual(
        readCallerTimeout(callerTimeoutImage('probe', { [field]: value }), expected),
        rejected(`${field} ${described}; expected ${shape}`),
        `${field} malformed`,
      );
    }
  });

  it('refuses a causation list out of order, repeated or holding a non-UUID', () => {
    const shape = 'a non-empty ascending list of distinct lowercase UUIDv4s';
    const [low, high] = [ATTEMPT_ID, CALLER_EVENT_ID].sort();
    for (const list of [
      [high, low],
      [low, low],
      [low, 'not-a-uuid'],
    ] as readonly JsonValue[]) {
      assert.deepEqual(
        readCallerTimeout(callerTimeoutImage('probe', { causation_event_ids: list }), expected),
        rejected(`causation_event_ids array ${JSON.stringify(list)}; expected ${shape}`),
      );
    }
    const ordered = callerTimeoutImage('probe', { causation_event_ids: [low ?? '', high ?? ''] });
    assert.deepEqual(readCallerTimeout(ordered, expected), VALID);
  });

  it('refuses a property the caller_timeout_recorded schema does not declare', () => {
    assert.deepEqual(
      readCallerTimeout(callerTimeoutImage('probe', { provider_transaction_id: CALLER_EVENT_ID }), expected),
      rejected(
        'property "provider_transaction_id" is not declared by caller_timeout_recorded; expected only its schema properties',
      ),
    );
  });

  it('accepts the values the schema admits on purpose for the oracle to judge (BR-RUA-011)', () => {
    const judgedLater = callerTimeoutImage('probe', {
      elapsed_ns: '12',
      arbiter_winner: 'TRANSPORT',
      transport_settled_at_claim: true,
    });
    assert.deepEqual(readCallerTimeout(judgedLater, expected), VALID);
  });

  it('describes values nested 100,000 levels deep without throwing (review r1, A-05)', () => {
    assert.deepEqual(
      readCallerTimeout(nestedArrays(HOSTILE_DEPTH), expected),
      rejected(`stream image is ${DESCRIBED_DEEP_ARRAYS}; expected a JSON object`, {}),
    );
    assert.deepEqual(
      readCallerTimeout(callerTimeoutImage('probe', { source: nestedObjects(HOSTILE_DEPTH) }), expected),
      rejected(`source ${DESCRIBED_DEEP_OBJECTS}; expected probe_caller`),
    );
    assert.deepEqual(
      readCallerTimeout(callerTimeoutImage('probe', { elapsed_ns: nestedArrays(HOSTILE_DEPTH) }), expected),
      rejected(`elapsed_ns ${DESCRIBED_DEEP_ARRAYS}; expected a decimal string of nanoseconds without leading zeros`),
    );
  });

  it('bounds the detail of a huge undeclared property name or field value (A-05)', () => {
    const name = 'x'.repeat(1_000_000);
    const undeclared = readCallerTimeout(callerTimeoutImage('probe', { [name]: 1 }), expected);
    assert.equal(undeclared.ok, false);
    assert.ok(undeclared.error.detail.length < 400, String(undeclared.error.detail.length));
    assert.match(
      undeclared.error.detail,
      /^property "x+…\[truncated\] is not declared by caller_timeout_recorded; expected only/,
    );
    const hugeSource = readCallerTimeout(callerTimeoutImage('probe', { source: name }), expected);
    assert.equal(hugeSource.ok, false);
    assert.ok(hugeSource.error.detail.length < 400, String(hugeSource.error.detail.length));
  });

  it('refuses non-finite numbers, as a JSON parse of 1e400 yields them (A-05)', () => {
    for (const nonFinite of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      assert.deepEqual(
        readCallerTimeout(callerTimeoutImage('probe', { source_sequence: nonFinite }), expected),
        rejected(`source_sequence number ${String(nonFinite)}; expected a safe integer >= 1`),
      );
      assert.deepEqual(
        readCallerTimeout(callerTimeoutImage('probe', { schema_version: nonFinite }), expected),
        rejected(
          `record_type string "caller_timeout_recorded" schema_version number ${String(nonFinite)}; expected caller_timeout_recorded version 1`,
        ),
      );
    }
  });

  it('refuses inherited member names as undeclared properties or wrong values, and never reads them (A-05)', () => {
    const own = JSON.parse(
      `{"__proto__":{"source":"probe_caller"},${JSON.stringify(callerTimeoutImage('probe')).slice(1)}`,
    ) as JsonObject;
    assert.deepEqual(
      readCallerTimeout(own, expected),
      rejected('property "__proto__" is not declared by caller_timeout_recorded; expected only its schema properties'),
    );
    for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
      assert.deepEqual(
        readCallerTimeout(callerTimeoutImage('probe', { [name]: 1 }), expected),
        rejected(`property "${name}" is not declared by caller_timeout_recorded; expected only its schema properties`),
        name,
      );
    }
    assert.deepEqual(
      readCallerTimeout(callerTimeoutImage('probe', { source: 'constructor' }), expected),
      rejected('source string "constructor"; expected probe_caller'),
    );
    const { source: _source, ...withoutSource } = callerTimeoutImage('probe');
    const inherited = Object.assign(Object.create({ source: 'probe_caller' }) as JsonObject, withoutSource);
    assert.deepEqual(readCallerTimeout(inherited, expected), rejected('source absent; expected probe_caller'));
  });
});
