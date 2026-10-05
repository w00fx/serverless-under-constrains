// The controller's readers of the control `config` and `treatment` items (design §9.3, §9.11).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decodeControllerConfig,
  decodeControllerTreatment,
} from '../../../src/treatment-controller/controller-control-items.ts';
import {
  ATTEMPT_ID,
  CALLER_EVENT_ID,
  COMMIT_EVENT_ID,
  MANIFEST_SHA,
  OTHER_TRIAL_ID,
  PROBE_PK,
  PROVIDER_COMMIT_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  TRIAL_PK,
  committedTreatmentItem,
  probeConfigItem,
  signalledTreatmentItem,
  trialConfigItem,
} from './support/controller-fixtures.ts';

const PROBE_PARTITION = { kind: 'probe', key: PROBE_PK } as const;
const TRIAL_PARTITION = { kind: 'trial', key: TRIAL_PK, trial_id: TRIAL_ID } as const;
const COMMIT = {
  targeted_attempt_id: ATTEMPT_ID,
  provider_commit_id: PROVIDER_COMMIT_ID,
  commit_event_id: COMMIT_EVENT_ID,
};

describe('decodeControllerConfig', () => {
  it('reads a probe configuration without a trial', () => {
    assert.deepEqual(decodeControllerConfig(probeConfigItem(), PROBE_PARTITION), {
      ok: true,
      value: {
        execution_manifest_sha256: MANIFEST_SHA,
        registered_caller_id: 'probe',
        scenario: 'COMMIT_THEN_TIMEOUT',
      },
    });
  });

  it('reads a trial configuration with the partition trial and its manifest digest', () => {
    assert.deepEqual(decodeControllerConfig(trialConfigItem('CONTROL'), TRIAL_PARTITION), {
      ok: true,
      value: {
        execution_manifest_sha256: MANIFEST_SHA,
        registered_caller_id: 'conventional',
        scenario: 'CONTROL',
        trial: { trial_id: TRIAL_ID, trial_manifest_sha256: TRIAL_MANIFEST_SHA },
      },
    });
  });

  it('refuses each malformed field with the offending value and the expected shape', () => {
    const cases: readonly [Parameters<typeof decodeControllerConfig>, string][] = [
      [
        [probeConfigItem({ execution_manifest_sha256: 'A'.repeat(64) }), PROBE_PARTITION],
        `control item ${PROBE_PK}/config: execution_manifest_sha256 string "${'A'.repeat(64)}"; expected 64 lowercase hex digits`,
      ],
      [
        [probeConfigItem({ registered_caller_id: 'runner' }), PROBE_PARTITION],
        `control item ${PROBE_PK}/config: registered_caller_id string "runner"; expected one of conventional, durable, probe`,
      ],
      [
        [probeConfigItem({ scenario: 'CHAOS' }), PROBE_PARTITION],
        `control item ${PROBE_PK}/config: scenario string "CHAOS"; expected one of CONTROL, COMMIT_THEN_TIMEOUT`,
      ],
      [
        [probeConfigItem({ trial_manifest_sha256: TRIAL_MANIFEST_SHA }), PROBE_PARTITION],
        `control item ${PROBE_PK}/config: trial_manifest_sha256 present on a transport-probe configuration; expected none`,
      ],
      [
        [probeConfigItem({ trial_id: TRIAL_ID }), PROBE_PARTITION],
        `control item ${PROBE_PK}/config: trial_id present on a transport-probe configuration; expected none`,
      ],
      [
        [trialConfigItem('CONTROL', { trial_id: OTHER_TRIAL_ID }), TRIAL_PARTITION],
        `control item ${TRIAL_PK}/config: trial_id string "${OTHER_TRIAL_ID}"; expected the partition trial ${TRIAL_ID}`,
      ],
      [
        [trialConfigItem('CONTROL', { trial_manifest_sha256: null }), TRIAL_PARTITION],
        `control item ${TRIAL_PK}/config: trial_manifest_sha256 null null; expected 64 lowercase hex digits`,
      ],
    ];
    for (const [[item, partition], error] of cases) {
      assert.deepEqual(decodeControllerConfig(item, partition), { ok: false, error });
    }
  });
});

describe('decodeControllerTreatment', () => {
  it('reads the states without identities', () => {
    for (const state of ['ARMED', 'SAFETY_RELEASED'] as const) {
      assert.deepEqual(decodeControllerTreatment({ pk: TRIAL_PK, sk: 'treatment', state, version: 4 }), {
        ok: true,
        value: { state },
      });
    }
  });

  it('reads a committed wait with its commit identities', () => {
    assert.deepEqual(decodeControllerTreatment(committedTreatmentItem(TRIAL_PK)), {
      ok: true,
      value: { state: 'COMMITTED_WAITING', ...COMMIT },
    });
  });

  it('reads a signalled state with the caller event that signalled it', () => {
    for (const state of ['TIMEOUT_SIGNALLED', 'TIMEOUT_OBSERVED', 'RESPONSE_RELEASED'] as const) {
      assert.deepEqual(decodeControllerTreatment(signalledTreatmentItem(TRIAL_PK, state)), {
        ok: true,
        value: { state, ...COMMIT, signal_caller_event_id: CALLER_EVENT_ID },
      });
    }
  });

  it('refuses an unknown state or a version that is not a positive safe integer', () => {
    const prefix = `control item ${TRIAL_PK}/treatment`;
    assert.deepEqual(decodeControllerTreatment({ pk: TRIAL_PK, sk: 'treatment', state: 'DONE', version: 1 }), {
      ok: false,
      error: `${prefix}: state string "DONE"; expected one of ARMED, COMMITTED_WAITING, TIMEOUT_SIGNALLED, TIMEOUT_OBSERVED, RESPONSE_RELEASED, SAFETY_RELEASED`,
    });
    for (const version of [0, 1.5, '2', 2 ** 53]) {
      assert.deepEqual(decodeControllerTreatment({ pk: TRIAL_PK, sk: 'treatment', state: 'ARMED', version }), {
        ok: false,
        error: `${prefix}: version ${typeof version} ${JSON.stringify(version)}; expected a safe integer >= 1`,
      });
    }
  });

  it('refuses a state whose implied identities are missing or malformed', () => {
    const prefix = `control item ${TRIAL_PK}/treatment`;
    for (const field of ['targeted_attempt_id', 'provider_commit_id', 'commit_event_id']) {
      assert.deepEqual(decodeControllerTreatment(committedTreatmentItem(TRIAL_PK, { [field]: 'x' })), {
        ok: false,
        error: `${prefix}: ${field} string "x" in state COMMITTED_WAITING; expected a lowercase RFC 4122 version-4 UUID`,
      });
    }
    const unsignalled = committedTreatmentItem(TRIAL_PK, { state: 'TIMEOUT_OBSERVED' });
    assert.deepEqual(decodeControllerTreatment(unsignalled), {
      ok: false,
      error: `${prefix}: signal_caller_event_id absent in state TIMEOUT_OBSERVED; expected a lowercase RFC 4122 version-4 UUID`,
    });
  });
});
