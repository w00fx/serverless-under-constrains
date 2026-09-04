import type { RefundCall } from "../controlled-provider/types.ts";
import { bindingKeyOf } from "../controlled-provider/refund-call.ts";
import { createPrimaryEvent } from "../protocol-records/event-records.ts";
import type { PrimaryEvent, ValidationResult } from "../protocol-records/types.ts";
import type { AttemptOutcome, DispatchState } from "./types.ts";

export type CallerEventFields = {
  record_type: string;
  event_id: string;
  occurred_at: string;
  source_instance_id: string;
  source_sequence: number;
  call: RefundCall;
  causation_event_ids?: readonly string[];
  extra?: Record<string, unknown>;
};

export function buildCallerEvent(fields: CallerEventFields): ValidationResult<PrimaryEvent> {
  const key = bindingKeyOf(fields.call);
  return createPrimaryEvent({
    schema_version: 1,
    record_type: fields.record_type,
    event_id: fields.event_id,
    occurred_at: fields.occurred_at,
    source: "caller",
    source_instance_id: fields.source_instance_id,
    source_sequence: fields.source_sequence,
    trial_manifest_sha256: fields.call.trial_manifest_sha256,
    trial_id: fields.call.trial_id,
    attempt_id: fields.call.attempt_id,
    provider_request_id: fields.call.provider_request_id,
    refund_request_id: fields.call.refund_request_id,
    payment_id: fields.call.payment_id,
    [key]: fields.call[key],
    causation_event_ids: fields.causation_event_ids,
    ...fields.extra,
  });
}

export function finishedExtra(
  outcome: AttemptOutcome,
  dispatchState: DispatchState,
): Record<string, unknown> {
  return {
    outcome,
    dispatch_state: dispatchState,
  };
}
