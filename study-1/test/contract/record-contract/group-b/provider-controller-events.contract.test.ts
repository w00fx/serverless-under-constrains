// Provider and treatment-controller journal records (catalogue rows 29-44 plus the warm-up
// pair): verbatim capture of untrusted identities, the commit plan's identities, causation of
// the treatment chain, and the rejection reasons of the controller (BR-RUA-022..027).

import { describe, it } from 'node:test';

import type { JsonObject } from '../../../../src/record-contract/primitives.ts';
import type { StudyRecord } from '../../../../src/record-contract/records/index.ts';
import * as controller from './examples/controller-examples.ts';
import * as provider from './examples/provider-examples.ts';
import {
  assertAccepted,
  assertForbidden,
  assertMissing,
  assertRejected,
} from '../../../support/record-contract/group-b-validation.ts';
import { textOf, withMember } from '../../../support/record-contract/json-paths.ts';
import { toJson, uuid } from '../../../support/record-contract/record-builders.ts';

function json(record: StudyRecord): JsonObject {
  return toJson(record);
}

const NON_SIGNALLED_STATES = ['ARMED', 'COMMITTED_WAITING', 'SAFETY_RELEASED'];

describe('AC-RUA-046 provider_call_received', () => {
  it('copies the caller-supplied identities verbatim, malformed or not', () => {
    const received = json(provider.providerCallReceived());
    for (const field of ['caller_id', 'attempt_id', 'provider_request_id', 'refund_request_id', 'payment_id']) {
      for (const value of ['', 'NOT-A-UUID', ' padded ', '00000000-0000-1000-8000-000000000001']) {
        assertAccepted(withMember(received, field, value), `${field} ${JSON.stringify(value)}`);
      }
      assertRejected(withMember(received, field, 1), `${field} as a number`, `/${field} type`);
    }
  });

  it('always names the provider call and the raw request digest', () => {
    const received = json(provider.providerCallReceived());
    assertMissing(withMember(received, 'provider_call_id', undefined), 'no call id', 'provider_call_id');
    assertMissing(withMember(received, 'raw_request_sha256', undefined), 'no digest', 'raw_request_sha256');
  });
});

describe('AC-RUA-046 validated provider records', () => {
  it('an accepted call names a catalogued caller', () => {
    const accepted = json(provider.providerCallAccepted());
    for (const callerId of ['probe', 'durable']) {
      assertAccepted(withMember(accepted, 'caller_id', callerId), callerId);
    }
    for (const callerId of ['Conventional', 'runner', '']) {
      assertRejected(withMember(accepted, 'caller_id', callerId), callerId, '/caller_id enum');
    }
  });

  it('a rejection names a catalogued reason and a detail', () => {
    const rejected = json(provider.providerCallRejected());
    assertRejected(withMember(rejected, 'reason', 'TIMEOUT'), 'unknown reason', '/reason enum');
    assertRejected(withMember(rejected, 'detail', ''), 'empty detail', '/detail minLength');
  });

  it('a commit records whether it was the targeted one', () => {
    const committed = json(provider.providerTransactionCommitted());
    assertAccepted(withMember(committed, 'targeted', false), 'untargeted commit');
    assertMissing(withMember(committed, 'targeted', undefined), 'no targeted flag', 'targeted');
    assertRejected(withMember(committed, 'error_code', 'X'), 'stray member', ' additionalProperties');
  });

  it('a failed commit names the error', () => {
    const failed = json(provider.providerCommitFailed());
    assertRejected(withMember(failed, 'error_code', ''), 'empty error code', '/error_code minLength');
  });
});

describe('AC-RUA-046 treatment chain causation', () => {
  it('observation, release and the controller signal each name their cause', () => {
    const caused = [
      json(provider.treatmentTimeoutObserved()),
      json(provider.treatmentResponseReleased()),
      json(controller.timeoutSignalRecorded()),
    ];
    for (const record of caused) {
      const label = textOf(record['record_type'] ?? null);
      assertMissing(withMember(record, 'causation_event_ids', undefined), label, 'causation_event_ids');
      assertRejected(withMember(record, 'causation_event_ids', []), label, '/causation_event_ids minItems');
    }
  });

  it('the controller signal lists its two causes in ascending order', () => {
    const signal = json(controller.timeoutSignalRecorded());
    assertRejected(withMember(signal, 'causation_event_ids', [uuid(14), uuid(6)]), 'descending causes');
  });
});

describe('AC-RUA-046 treatment_safety_released', () => {
  it('a release from ARMED names no commit', () => {
    const armed = json(provider.armedSafetyRelease());
    for (const field of ['provider_commit_id', 'provider_call_id', 'attempt_id', 'elapsed_since_commit_ns']) {
      const value = field === 'elapsed_since_commit_ns' ? '1' : uuid(0x700);
      assertForbidden(withMember(armed, field, value), `ARMED with ${field}`, `/${field}`);
    }
  });

  it('a release after commit names the commit, the call and the attempt', () => {
    const committed = json(provider.committedSafetyRelease());
    for (const field of ['provider_commit_id', 'provider_call_id', 'attempt_id']) {
      assertMissing(withMember(committed, field, undefined), `without ${field}`, field);
    }
    for (const state of ['TIMEOUT_SIGNALLED', 'TIMEOUT_OBSERVED']) {
      assertAccepted(withMember(committed, 'from_state', state), state);
    }
    for (const state of ['RESPONSE_RELEASED', 'SAFETY_RELEASED']) {
      assertRejected(withMember(committed, 'from_state', state), `terminal ${state}`, '/from_state enum');
    }
  });
});

describe('AC-RUA-046 controller signal outcomes', () => {
  it('duplicates and conflicts are observed only on a signalled treatment', () => {
    const records = [
      json(controller.timeoutSignalDuplicateObserved()),
      json(controller.timeoutSignalConflictRecorded()),
    ];
    for (const record of records) {
      assertAccepted(withMember(record, 'treatment_state', 'RESPONSE_RELEASED'), 'released');
      for (const state of NON_SIGNALLED_STATES) {
        assertRejected(withMember(record, 'treatment_state', state), state, '/treatment_state enum');
      }
    }
  });

  it('a late signal is rejected only after the safety release', () => {
    const late = json(controller.lateTimeoutSignalRejected());
    assertRejected(withMember(late, 'treatment_state', 'RESPONSE_RELEASED'), 'released', '/treatment_state enum');
  });

  it('a readable caller timeout names its event and attempt', () => {
    const readable = [
      json(controller.controlTrialCallerTimeout()),
      json(controller.beforeCommitCallerTimeout()),
      json(controller.notTargetedCallerTimeout()),
    ];
    for (const record of readable) {
      const label = textOf(record['reason'] ?? null);
      assertMissing(withMember(record, 'caller_timeout_event_id', undefined), label, 'caller_timeout_event_id');
      assertMissing(withMember(record, 'attempt_id', undefined), label, 'attempt_id');
    }
  });

  it('the treatment state matches the rejection reason', () => {
    const control = json(controller.controlTrialCallerTimeout());
    assertForbidden(withMember(control, 'treatment_state', 'ARMED'), 'CONTROL_TRIAL state', '/treatment_state');
    const beforeCommit = json(controller.beforeCommitCallerTimeout());
    assertMissing(withMember(beforeCommit, 'treatment_state', undefined), 'BEFORE_COMMIT', 'treatment_state');
    assertRejected(
      withMember(beforeCommit, 'treatment_state', 'COMMITTED_WAITING'),
      'BEFORE_COMMIT',
      '/treatment_state const',
    );
    const notTargeted = json(controller.notTargetedCallerTimeout());
    assertMissing(withMember(notTargeted, 'treatment_state', undefined), 'NOT_TARGETED', 'treatment_state');
    assertRejected(withMember(notTargeted, 'treatment_state', 'ARMED'), 'NOT_TARGETED', '/treatment_state const');
    const invalid = json(controller.invalidCallerTimeout());
    assertAccepted(withMember(invalid, 'treatment_state', 'SAFETY_RELEASED'), 'INVALID_EVENT any state');
    assertRejected(withMember(invalid, 'reason', 'LATE'), 'unknown reason', '/reason enum');
  });
});
