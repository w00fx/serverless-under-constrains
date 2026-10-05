// The §9.11 controller decision table, one case per row plus the ordering between rows
// (BR-RUA-025). Expectations come from the design table, never from running the controller.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  ControllerConfigView,
  ControllerTreatment,
} from '../../../src/treatment-controller/controller-control-items.ts';
import { decideSignal } from '../../../src/treatment-controller/signal-decision.ts';
import type { SignalContext } from '../../../src/treatment-controller/signal-decision.ts';
import {
  ATTEMPT_ID,
  CALLER_EVENT_ID,
  COMMIT_EVENT_ID,
  MANIFEST_SHA,
  OTHER_ATTEMPT_ID,
  OTHER_CALLER_EVENT_ID,
  OTHER_SHA,
  PROBE,
  PROVIDER_COMMIT_ID,
  RUN,
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
const TRIAL: SignalContext = { kind: 'experiment', deployment: RUN, configuration: TRIAL_CONFIG };
const PROBE_CONTEXT: SignalContext = {
  kind: 'experiment',
  deployment: PROBE,
  configuration: {
    execution_manifest_sha256: MANIFEST_SHA,
    registered_caller_id: 'probe',
    scenario: 'COMMIT_THEN_TIMEOUT',
  },
};
const CONTROL: SignalContext = { ...TRIAL, configuration: { ...TRIAL_CONFIG, scenario: 'CONTROL' } };
const COMMIT = {
  targeted_attempt_id: ATTEMPT_ID,
  provider_commit_id: PROVIDER_COMMIT_ID,
  commit_event_id: COMMIT_EVENT_ID,
};
const COMMITTED: ControllerTreatment = { state: 'COMMITTED_WAITING', ...COMMIT };
const REFS = { caller_timeout_event_id: CALLER_EVENT_ID, attempt_id: ATTEMPT_ID } as const;
const IMAGE = callerTimeoutImage('trial');

function signalled(
  state: 'TIMEOUT_SIGNALLED' | 'TIMEOUT_OBSERVED' | 'RESPONSE_RELEASED',
  caller = CALLER_EVENT_ID,
): ControllerTreatment {
  return { state, ...COMMIT, signal_caller_event_id: caller };
}

describe('decideSignal (design §9.11)', () => {
  it('canary partition: canary_acknowledged with the canary event', () => {
    assert.deepEqual(decideSignal(callerTimeoutImage('canary'), { kind: 'canary', deployment: PROBE }, undefined), {
      kind: 'canary_acknowledged',
      canary_event_id: CALLER_EVENT_ID,
    });
  });

  it('canary partition: an invalid canary is invalid_event_rejected', () => {
    const decision = decideSignal(
      callerTimeoutImage('canary', { source: 'probe_caller' }),
      { kind: 'canary', deployment: PROBE },
      undefined,
    );
    assert.deepEqual(decision, {
      kind: 'invalid_event_rejected',
      detail: 'source string "probe_caller"; expected runner',
      ...REFS,
    });
  });

  it('invalid event or identity mismatch: invalid_event_rejected, whatever the treatment, naming its state', () => {
    const image = callerTimeoutImage('trial', { execution_manifest_sha256: OTHER_SHA });
    const detail = `execution_manifest_sha256 string "${OTHER_SHA}"; expected ${MANIFEST_SHA}`;
    assert.deepEqual(decideSignal(image, TRIAL, COMMITTED), {
      kind: 'invalid_event_rejected',
      detail,
      ...REFS,
      treatment_state: 'COMMITTED_WAITING',
    });
    assert.deepEqual(decideSignal(image, CONTROL, undefined), { kind: 'invalid_event_rejected', detail, ...REFS });
  });

  it('CONTROL configuration: control_trial_rejected', () => {
    assert.deepEqual(decideSignal(IMAGE, CONTROL, undefined), {
      kind: 'control_trial_rejected',
      ...REFS,
      detail: 'scenario CONTROL arms no treatment; nothing to signal',
    });
  });

  it('COMMIT_THEN_TIMEOUT without a treatment item: invalid_event_rejected', () => {
    assert.deepEqual(decideSignal(IMAGE, TRIAL, undefined), {
      kind: 'invalid_event_rejected',
      ...REFS,
      detail: 'no treatment item in a COMMIT_THEN_TIMEOUT partition; expected one armed before publication',
    });
  });

  it('ARMED: before_commit_rejected', () => {
    assert.deepEqual(decideSignal(IMAGE, TRIAL, { state: 'ARMED' }), {
      kind: 'before_commit_rejected',
      ...REFS,
      detail: 'treatment ARMED; the targeted commit has not happened',
    });
  });

  it('COMMITTED_WAITING, match: signal with causation sorted [commit event, caller event]', () => {
    assert.deepEqual(decideSignal(IMAGE, TRIAL, COMMITTED), {
      kind: 'signal',
      ...REFS,
      causation: [CALLER_EVENT_ID, COMMIT_EVENT_ID],
      provider_commit_id: PROVIDER_COMMIT_ID,
      commit_event_id: COMMIT_EVENT_ID,
    });
    const lowCommit: ControllerTreatment = {
      ...COMMITTED,
      commit_event_id: '00000000-0000-4000-8000-000000000001' as typeof COMMIT_EVENT_ID,
    };
    const decision = decideSignal(callerTimeoutImage('probe'), PROBE_CONTEXT, lowCommit);
    assert.equal(decision.kind, 'signal');
    assert.deepEqual(decision.causation, ['00000000-0000-4000-8000-000000000001', CALLER_EVENT_ID]);
  });

  it('COMMITTED_WAITING, no match: not_targeted_rejected', () => {
    const image = callerTimeoutImage('trial', { attempt_id: OTHER_ATTEMPT_ID });
    assert.deepEqual(decideSignal(image, TRIAL, COMMITTED), {
      kind: 'not_targeted_rejected',
      caller_timeout_event_id: CALLER_EVENT_ID,
      attempt_id: OTHER_ATTEMPT_ID,
      detail: `attempt_id ${OTHER_ATTEMPT_ID}; expected the targeted attempt ${ATTEMPT_ID}`,
    });
  });

  it('signalled states, this event: duplicate_ignored', () => {
    for (const state of ['TIMEOUT_SIGNALLED', 'TIMEOUT_OBSERVED', 'RESPONSE_RELEASED'] as const) {
      assert.deepEqual(decideSignal(IMAGE, TRIAL, signalled(state)), {
        kind: 'duplicate_ignored',
        ...REFS,
        treatment_state: state,
      });
    }
  });

  it('signalled states, another event: conflict naming the existing signal caller event', () => {
    for (const state of ['TIMEOUT_SIGNALLED', 'TIMEOUT_OBSERVED', 'RESPONSE_RELEASED'] as const) {
      assert.deepEqual(decideSignal(IMAGE, TRIAL, signalled(state, OTHER_CALLER_EVENT_ID)), {
        kind: 'conflict',
        ...REFS,
        existing_caller_event_id: OTHER_CALLER_EVENT_ID,
        treatment_state: state,
      });
    }
  });

  it('SAFETY_RELEASED: late_rejected, for a matching or another attempt', () => {
    assert.deepEqual(decideSignal(IMAGE, TRIAL, { state: 'SAFETY_RELEASED' }), { kind: 'late_rejected', ...REFS });
    const other = callerTimeoutImage('trial', { attempt_id: OTHER_ATTEMPT_ID });
    assert.deepEqual(decideSignal(other, TRIAL, { state: 'SAFETY_RELEASED' }), {
      kind: 'late_rejected',
      caller_timeout_event_id: CALLER_EVENT_ID,
      attempt_id: OTHER_ATTEMPT_ID,
    });
  });
});
