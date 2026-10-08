// AttemptResolution helpers: a transport-won settlement becomes a DISPATCHED resolution with the
// parsed fields, the outcome event body is the correlation plus the resolution, and the report
// carries the BR-RUA-022 outcome class and drops the response diagnostics.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AttemptResolution } from '../../../src/provider-client/attempt-resolution.ts';
import {
  outcomeRecordBody,
  resolutionFromResponse,
  toAttemptReport,
} from '../../../src/provider-client/attempt-resolution.ts';
import type { DecimalString, Uuid4 } from '../../../src/record-contract/primitives.ts';
import {
  FIRST_ATTEMPT_ID,
  FIRST_PROVIDER_REQUEST_ID,
  PROVIDER_CALL_ID,
  PROVIDER_TRANSACTION_ID,
} from '../../support/provider-client/provider-client-fixtures.ts';

const IDS = { attempt_id: FIRST_ATTEMPT_ID, provider_request_id: FIRST_PROVIDER_REQUEST_ID };
const ELAPSED = '1234' as DecimalString;
const OUTCOME_EVENT_ID = 'eeeeeeee-0000-4000-8000-0000000000ee' as Uuid4;

describe('resolutionFromResponse', () => {
  it('maps succeeded, rejected and failed settlements to DISPATCHED resolutions', () => {
    assert.deepEqual(
      resolutionFromResponse(
        {
          kind: 'succeeded',
          executed_version: '7',
          provider_call_id: PROVIDER_CALL_ID,
          provider_transaction_id: PROVIDER_TRANSACTION_ID,
        },
        ELAPSED,
      ),
      {
        executed_version: '7',
        provider_call_id: PROVIDER_CALL_ID,
        provider_transaction_id: PROVIDER_TRANSACTION_ID,
        dispatch_to_settlement_ns: ELAPSED,
        outcome: 'SUCCEEDED',
        dispatch_state: 'DISPATCHED',
      },
    );
    assert.deepEqual(
      resolutionFromResponse(
        { kind: 'rejected', provider_call_id: PROVIDER_CALL_ID, rejection_reason: 'AMOUNT_INVALID' },
        ELAPSED,
      ),
      {
        provider_call_id: PROVIDER_CALL_ID,
        rejection_reason: 'AMOUNT_INVALID',
        dispatch_to_settlement_ns: ELAPSED,
        outcome: 'REJECTED',
        dispatch_state: 'DISPATCHED',
      },
    );
    const failure = {
      code: 'FUNCTION_ERROR',
      subject: 'BR-RUA-053',
      detail: 'function error "Unhandled"; expected none',
    } as const;
    assert.deepEqual(resolutionFromResponse({ kind: 'failed', function_error: 'Unhandled', failure }, ELAPSED), {
      function_error: 'Unhandled',
      failure,
      dispatch_to_settlement_ns: ELAPSED,
      outcome: 'FAILED',
      dispatch_state: 'DISPATCHED',
    });
  });
});

describe('outcomeRecordBody', () => {
  it('is the correlation plus the resolution', () => {
    const resolution: AttemptResolution = {
      outcome: 'TIMED_OUT',
      dispatch_state: 'DISPATCHED',
      dispatch_to_settlement_ns: ELAPSED,
    };
    assert.deepEqual(outcomeRecordBody({ ...IDS, refund_request_id: 'ref-poc-001' }, resolution), {
      ...IDS,
      refund_request_id: 'ref-poc-001',
      outcome: 'TIMED_OUT',
      dispatch_state: 'DISPATCHED',
      dispatch_to_settlement_ns: ELAPSED,
    });
  });
});

describe('toAttemptReport', () => {
  it('adds the outcome class and the outcome event, and drops the response diagnostics', () => {
    const report = toAttemptReport(
      IDS,
      {
        outcome: 'SUCCEEDED',
        dispatch_state: 'DISPATCHED',
        provider_call_id: PROVIDER_CALL_ID,
        provider_transaction_id: PROVIDER_TRANSACTION_ID,
        executed_version: '7',
        function_error: 'x',
      },
      OUTCOME_EVENT_ID,
    );
    assert.deepEqual(report, {
      ...IDS,
      outcome: 'SUCCEEDED',
      dispatch_state: 'DISPATCHED',
      provider_call_id: PROVIDER_CALL_ID,
      provider_transaction_id: PROVIDER_TRANSACTION_ID,
      outcome_class: 'SUCCESS',
      outcome_event_id: OUTCOME_EVENT_ID,
    });
  });

  it('classifies each outcome and omits an unrecorded outcome event', () => {
    const failure = { code: 'CALL_BUILD_FAILED', subject: 'BR-RUA-021', detail: 'd' } as const;
    const cases: readonly (readonly [AttemptResolution, string])[] = [
      [
        {
          outcome: 'REJECTED',
          dispatch_state: 'DISPATCHED',
          provider_call_id: PROVIDER_CALL_ID,
          rejection_reason: 'SCHEMA_INVALID',
        },
        'REJECTION',
      ],
      [{ outcome: 'TIMED_OUT', dispatch_state: 'DISPATCHED' }, 'AMBIGUOUS'],
      [{ outcome: 'FAILED', dispatch_state: 'NOT_DISPATCHED', failure }, 'PRE_DISPATCH_FAILURE'],
      [{ outcome: 'FAILED', dispatch_state: 'UNKNOWN', failure }, 'AMBIGUOUS'],
      [{ outcome: 'FAILED', dispatch_state: 'DISPATCHED', failure }, 'AMBIGUOUS'],
    ];
    for (const [resolution, outcomeClass] of cases) {
      const report = toAttemptReport(IDS, resolution, undefined);
      assert.equal(report.outcome_class, outcomeClass, JSON.stringify(resolution));
      assert.equal('outcome_event_id' in report, false);
    }
  });

  it('throws on a resolution that contradicts BR-RUA-021', () => {
    const forged = { outcome: 'TIMED_OUT', dispatch_state: 'NOT_DISPATCHED' } as unknown as AttemptResolution;
    assert.throws(() => toAttemptReport(IDS, forged, undefined), {
      name: 'Error',
      message: `attempt ${FIRST_ATTEMPT_ID} resolved inconsistently: outcome TIMED_OUT with dispatch state NOT_DISPATCHED; expected DISPATCHED or UNKNOWN, because SUCCEEDED, REJECTED and TIMED_OUT imply DISPATCHED`,
    });
  });
});
