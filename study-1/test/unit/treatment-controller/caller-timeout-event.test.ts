// The controller's validation of an inserted caller timeout (BR-RUA-025, design §9.11 "invalid
// event, or identity mismatch"; D-10 canary written by the runner).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonValue } from '../../../src/record-contract/primitives.ts';
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
