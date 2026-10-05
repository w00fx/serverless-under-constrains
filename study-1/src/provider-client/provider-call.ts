// Step C2 of design §5.3: building the `provider_refund_call` locally, before any dispatch.
// The call names exactly one execution identity: a variant caller (conventional or durable)
// calls inside a trial of a run or a variant validation, and the probe caller calls inside the
// transport probe, which has no trial (D-06). A caller whose journal scope cannot carry such an
// identity cannot build a call; that failure happens before dispatch, so the client proves it
// with the conditional `PRE_DISPATCH -> NOT_DISPATCHED` transition (BR-RUA-021, AC-RUA-015).

import type { JournalScope } from '../event-journal/journal-scope.ts';
import type { Result, StructuredReason, Uuid4 } from '../record-contract/primitives.ts';
import type { ProviderCallScope, ProviderRefundCall } from '../record-contract/records/group-a/provider_refund_call.ts';
import type { AttemptInput } from './attempt-input.ts';

/** The caller-generated identities of one physical attempt (INV-RUA-001). */
export interface AttemptIds {
  readonly attempt_id: Uuid4;
  readonly provider_request_id: Uuid4;
}

/** A local call-build failure: always `CALL_BUILD_FAILED`, a pre-dispatch failure code. */
export type CallBuildFailure = StructuredReason & { readonly code: 'CALL_BUILD_FAILED' };

/**
 * Builds the call of one attempt within `scope`, or the reason no valid call exists.
 *
 * @example
 * const built = buildProviderCall(input, { attempt_id, provider_request_id }, trialScope);
 * if (built.ok) await invoker.invoke(built.value, signal);
 */
export function buildProviderCall(
  input: AttemptInput,
  ids: AttemptIds,
  scope: JournalScope,
): Result<ProviderRefundCall, CallBuildFailure> {
  const callScope = callScopeFor(input.caller_id, scope);
  if (!callScope.ok) {
    return callScope;
  }
  const call: ProviderRefundCall = {
    ...callScope.value,
    schema_version: 1,
    record_type: 'provider_refund_call',
    execution_manifest_sha256: scope.execution_manifest_sha256,
    attempt_id: ids.attempt_id,
    provider_request_id: ids.provider_request_id,
    refund_request_id: input.refund_request_id,
    payment_id: input.payment_id,
    amount_minor: input.amount_minor,
    currency: input.currency,
  };
  return { ok: true, value: call };
}

function callScopeFor(
  callerId: AttemptInput['caller_id'],
  scope: JournalScope,
): Result<ProviderCallScope, CallBuildFailure> {
  const { execution, partition } = scope;
  if (callerId === 'probe') {
    if (execution.execution_kind === 'TRANSPORT_PROBE' && partition.kind === 'probe') {
      return { ok: true, value: { caller_id: 'probe', transport_probe_id: execution.transport_probe_id } };
    }
    return buildFailure(callerId, scope, 'a TRANSPORT_PROBE execution in the probe partition');
  }
  if (execution.execution_kind === 'TRANSPORT_PROBE' || partition.kind !== 'trial') {
    return buildFailure(callerId, scope, 'a RUN or VARIANT_VALIDATION execution in a trial partition');
  }
  const trial = { trial_id: partition.trial_id, trial_manifest_sha256: partition.trial_manifest_sha256 };
  if (execution.execution_kind === 'RUN') {
    return { ok: true, value: { caller_id: callerId, run_id: execution.run_id, ...trial } };
  }
  return { ok: true, value: { caller_id: callerId, variant_validation_id: execution.variant_validation_id, ...trial } };
}

function buildFailure(
  callerId: AttemptInput['caller_id'],
  scope: JournalScope,
  expected: string,
): { readonly ok: false; readonly error: CallBuildFailure } {
  return {
    ok: false,
    error: {
      code: 'CALL_BUILD_FAILED',
      subject: 'BR-RUA-021',
      detail: `caller ${callerId} in a ${scope.execution.execution_kind} execution with partition ${scope.partition.kind}; expected ${expected}`,
    },
  };
}
