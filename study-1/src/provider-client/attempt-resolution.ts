// How one attempt ended (BR-RUA-021): its outcome, its dispatch state and the evidence fields
// the `attempt_outcome_recorded` event carries, plus the report the calling variant receives.
// A resolution uses the record's own field names, so the outcome event is the attempt's
// correlation plus the resolution, with nothing renamed on the way to the journal.

import { classifyOutcome } from '../attempt-lifecycle/outcome-classification.ts';
import type { OutcomeClass } from '../attempt-lifecycle/outcome-classification.ts';
import type { EventBody } from '../event-journal/journal-event.ts';
import type { DecimalString, StructuredReason, Uuid4 } from '../record-contract/primitives.ts';
import type { AttemptCorrelation } from '../record-contract/records/group-b/shared-shapes.ts';
import type {
  AttemptFailureCode,
  AttemptOutcome,
  DispatchState,
  ProviderRejectionReason,
} from '../record-contract/records/group-b/vocabulary.ts';
import type { AttemptIds } from './provider-call.ts';
import type { ParsedProviderResponse, ResponseDiagnostics } from './provider-response.ts';

export type AttemptFailureReason = StructuredReason & { readonly code: AttemptFailureCode };

interface ResolutionTiming {
  /** Monotonic nanoseconds from the dispatch origin to the arbiter decision; absent when never dispatched. */
  readonly dispatch_to_settlement_ns?: DecimalString;
}

type ResolutionCommon = ResponseDiagnostics & ResolutionTiming;

export type AttemptResolution =
  | (ResolutionCommon & {
      readonly outcome: 'SUCCEEDED';
      readonly dispatch_state: 'DISPATCHED';
      readonly provider_call_id: Uuid4;
      readonly provider_transaction_id: Uuid4;
    })
  | (ResolutionCommon & {
      readonly outcome: 'REJECTED';
      readonly dispatch_state: 'DISPATCHED';
      readonly provider_call_id: Uuid4;
      readonly rejection_reason: ProviderRejectionReason;
    })
  | (ResolutionCommon & { readonly outcome: 'TIMED_OUT'; readonly dispatch_state: 'DISPATCHED' })
  | (ResolutionCommon & {
      readonly outcome: 'FAILED';
      readonly dispatch_state: DispatchState;
      readonly failure: AttemptFailureReason;
    });

/** What `performAttempt` returns to the variant or the probe caller (design §5.3). */
export interface AttemptReport {
  readonly attempt_id: Uuid4;
  readonly provider_request_id: Uuid4;
  readonly outcome: AttemptOutcome;
  readonly dispatch_state: DispatchState;
  readonly outcome_class: OutcomeClass;
  readonly provider_call_id?: Uuid4;
  readonly provider_transaction_id?: Uuid4;
  readonly rejection_reason?: ProviderRejectionReason;
  readonly failure?: AttemptFailureReason;
  readonly dispatch_to_settlement_ns?: DecimalString;
  /** The `attempt_outcome_recorded` event, absent when the journal could not record it. */
  readonly outcome_event_id?: Uuid4;
}

/**
 * The resolution of a settlement the transport won: the parsed response, dispatched.
 *
 * @example
 * resolutionFromResponse(parseProviderResponse(result, expected), '1200000000');
 * // { outcome: 'SUCCEEDED', dispatch_state: 'DISPATCHED', provider_call_id, provider_transaction_id, ... }
 */
export function resolutionFromResponse(
  parsed: ParsedProviderResponse,
  dispatchToSettlementNs: DecimalString,
): AttemptResolution {
  const timing = { dispatch_to_settlement_ns: dispatchToSettlementNs };
  switch (parsed.kind) {
    case 'succeeded': {
      const { kind: _kind, ...fields } = parsed;
      return { ...fields, ...timing, outcome: 'SUCCEEDED', dispatch_state: 'DISPATCHED' };
    }
    case 'rejected': {
      const { kind: _kind, ...fields } = parsed;
      return { ...fields, ...timing, outcome: 'REJECTED', dispatch_state: 'DISPATCHED' };
    }
    case 'failed': {
      const { kind: _kind, ...fields } = parsed;
      return { ...fields, ...timing, outcome: 'FAILED', dispatch_state: 'DISPATCHED' };
    }
  }
}

/**
 * The record-specific fields of the attempt's `attempt_outcome_recorded` event.
 *
 * @example
 * await journal.append('attempt_outcome_recorded', outcomeRecordBody(correlation, resolution), [dispatchEventId]);
 */
export function outcomeRecordBody(
  correlation: AttemptCorrelation,
  resolution: AttemptResolution,
): EventBody<'attempt_outcome_recorded'> {
  return { ...correlation, ...resolution };
}

/**
 * The report of a resolved attempt. Throws an Error when the resolution pairs an outcome with
 * a dispatch state BR-RUA-021 forbids, which only a defect in the client can produce.
 *
 * @example
 * toAttemptReport(ids, { outcome: 'TIMED_OUT', dispatch_state: 'DISPATCHED' }, outcomeEventId).outcome_class; // 'AMBIGUOUS'
 */
export function toAttemptReport(
  ids: AttemptIds,
  resolution: AttemptResolution,
  outcomeEventId: Uuid4 | undefined,
): AttemptReport {
  const outcomeClass = classifyOutcome(resolution.outcome, resolution.dispatch_state);
  if (!outcomeClass.ok) {
    throw new Error(`attempt ${ids.attempt_id} resolved inconsistently: ${outcomeClass.error.detail}`);
  }
  const { executed_version: _version, function_error: _functionError, ...reported } = resolution;
  return {
    ...ids,
    ...reported,
    outcome_class: outcomeClass.value,
    ...(outcomeEventId === undefined ? {} : { outcome_event_id: outcomeEventId }),
  };
}
