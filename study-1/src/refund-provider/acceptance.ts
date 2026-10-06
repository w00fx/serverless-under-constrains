// BR-RUA-018 acceptance, as the ordered checks of design §9.10. The first failing check names
// the rejection reason. The provider deliberately does not compare the amount or the refund
// identity with any approved refund, keeps no cumulative limit, accepts no idempotency key and
// performs no deduplication: those are properties the oracle evaluates, never the provider
// (ADR keep-business-invariants-out-of-the-controlled-provider).

import { isJsonObject } from '../record-contract/json-value.ts';
import type { ExecutionIdentity, JsonValue, Uuid4 } from '../record-contract/primitives.ts';
import type { ProviderCallerId } from '../record-contract/records/group-a/provider_refund_call.ts';
import type { ProviderRejectionReason } from '../record-contract/records/group-b/vocabulary.ts';
import type { PaymentView, ProviderConfigView } from './control-items.ts';
import { describeExecution, sameExecution } from './execution-identity-fields.ts';
import type { CallTrial, RefundCallShape } from './refund-call-shape.ts';
import { amountViolation, guardRefundCallShape, identityStructureViolation } from './refund-call-shape.ts';
import { describeUntrusted, excerptUntrusted } from './untrusted-json.ts';

/** What the provider knows when it judges one call. */
export interface AcceptanceContext {
  /** The execution this deployment belongs to (from the function environment). */
  readonly deployment_execution: ExecutionIdentity;
  /** The frozen configuration of the call's partition, read with a consistent read. */
  readonly trial_configuration: ProviderConfigView;
  /** The payment the call names, when it exists in the partition. */
  readonly payment: PaymentView | undefined;
}

/** A call that passed every check, with checked types. */
export interface AcceptedCall {
  readonly caller_id: ProviderCallerId;
  readonly attempt_id: Uuid4;
  readonly provider_request_id: Uuid4;
  readonly refund_request_id: string;
  readonly payment_id: string;
  readonly amount_minor: number;
  readonly currency: string;
}

export type AcceptanceDecision =
  | { readonly accepted: true; readonly call: AcceptedCall }
  | { readonly accepted: false; readonly reason: ProviderRejectionReason; readonly detail: string };

/**
 * Judges one received call. Pure and total over any value the runtime's JSON.parse produces,
 * including non-finite numbers and nesting of any depth; details echo bounded excerpts.
 *
 * @example
 * const decision = evaluateAcceptance(raw, { deployment_execution, trial_configuration, payment });
 * if (!decision.accepted) return rejected(decision.reason, decision.detail);
 */
export function evaluateAcceptance(raw: JsonValue, ctx: AcceptanceContext): AcceptanceDecision {
  const registered = ctx.trial_configuration.registered_caller_id;
  const caller = isJsonObject(raw) ? raw['caller_id'] : undefined;
  if (caller !== registered) {
    return reject(
      'AUTHORIZATION_FAILED',
      `caller_id ${describeUntrusted(caller)}; expected the registered caller ${JSON.stringify(registered)}`,
    );
  }
  const shape = guardRefundCallShape(raw);
  if (!shape.ok) {
    return reject('SCHEMA_INVALID', shape.error);
  }
  return judgeShape(shape.value, ctx);
}

function judgeShape(shape: RefundCallShape, ctx: AcceptanceContext): AcceptanceDecision {
  const identity = executionMismatch(shape, ctx);
  if (identity !== undefined) {
    return reject('EXECUTION_IDENTITY_MISMATCH', identity);
  }
  const structure = identityStructureViolation(shape);
  if (structure !== undefined) {
    return reject('IDENTITY_STRUCTURE_INVALID', structure);
  }
  const payment = ctx.payment;
  if (payment?.payment_id !== shape.payment_id) {
    return reject(
      'PAYMENT_NOT_FOUND',
      `payment_id ${excerptUntrusted(shape.payment_id)}; expected a payment that exists in the trial partition`,
    );
  }
  const amount = amountViolation(shape);
  if (amount !== undefined) {
    return reject('AMOUNT_INVALID', amount);
  }
  if (shape.currency !== payment.currency) {
    return reject(
      'CURRENCY_MISMATCH',
      `currency ${JSON.stringify(shape.currency)}; expected the payment currency ${excerptUntrusted(payment.currency)}`,
    );
  }
  return { accepted: true, call: acceptedCallOf(shape) };
}

function executionMismatch(shape: RefundCallShape, ctx: AcceptanceContext): string | undefined {
  const active = ctx.deployment_execution;
  if (!sameExecution(shape.execution, active)) {
    return `execution ${describeExecution(shape.execution)}; expected the active execution ${describeExecution(active)}`;
  }
  const digest = ctx.trial_configuration.execution_manifest_sha256;
  if (shape.execution_manifest_sha256 !== digest) {
    return `execution_manifest_sha256 ${shape.execution_manifest_sha256}; expected the frozen manifest ${digest}`;
  }
  return trialMismatch(shape.trial, ctx.trial_configuration.trial);
}

function trialMismatch(call: CallTrial | undefined, configured: CallTrial | undefined): string | undefined {
  if (call?.trial_id === configured?.trial_id && call?.trial_manifest_sha256 === configured?.trial_manifest_sha256) {
    return undefined;
  }
  return `trial ${describeTrial(call)}; expected the configured trial ${describeTrial(configured)}`;
}

function describeTrial(trial: CallTrial | undefined): string {
  return trial === undefined ? 'none' : `${trial.trial_id} (manifest ${trial.trial_manifest_sha256})`;
}

function acceptedCallOf(shape: RefundCallShape): AcceptedCall {
  // identityStructureViolation proved both identities are UUIDv4; the casts restate it.
  return {
    caller_id: shape.caller_id,
    attempt_id: shape.attempt_id as Uuid4,
    provider_request_id: shape.provider_request_id as Uuid4,
    refund_request_id: shape.refund_request_id,
    payment_id: shape.payment_id,
    amount_minor: shape.amount_minor,
    currency: shape.currency,
  };
}

function reject(reason: ProviderRejectionReason, detail: string): AcceptanceDecision {
  return { accepted: false, reason, detail };
}
