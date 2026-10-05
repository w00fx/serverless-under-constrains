// Canonical valid examples of the group A input and wire records, written from the spec text
// (CTR-RUA-005, CTR-RUA-006, BR-RUA-036, BR-RUA-041, BR-RUA-018, BR-RUA-027) and typed by the
// record interfaces, so each example is valid for both the schema and the TypeScript contract.

import type { ApprovedDecision } from '../../../../../src/record-contract/records/group-a/approved_decision.ts';
import type { EnvironmentInput } from '../../../../../src/record-contract/records/group-a/environment_input.ts';
import type { Payment } from '../../../../../src/record-contract/records/group-a/payment.ts';
import type { ProbeWorkloadRequest } from '../../../../../src/record-contract/records/group-a/probe_workload_request.ts';
import type { ProviderRefundCall } from '../../../../../src/record-contract/records/group-a/provider_refund_call.ts';
import type {
  ProviderRefundRejected,
  ProviderRefundSucceeded,
} from '../../../../../src/record-contract/records/group-a/provider_refund_response.ts';
import type { TrialMessage } from '../../../../../src/record-contract/records/group-a/trial_message.ts';
import { ACCOUNT_ID, COORDINATION_STACK_ID, COORDINATION_TABLE_ARN, DIGESTS, FIXTURE, IDS } from './sample-values.ts';

export function environmentInput(): EnvironmentInput {
  return {
    schema_version: 1,
    record_type: 'environment_input',
    account_allowlist: [ACCOUNT_ID],
    coordination_table_arn: COORDINATION_TABLE_ARN,
    coordination_stack_id: COORDINATION_STACK_ID,
    expected_coordination_schema_version: 1,
  };
}

/** CTR-RUA-005 verbatim. */
export function payment(): Payment {
  return {
    schema_version: 1,
    record_type: 'payment',
    payment_id: FIXTURE.payment_id,
    captured_amount_minor: FIXTURE.amount_minor,
    currency: FIXTURE.currency,
  };
}

/** CTR-RUA-006 verbatim. */
export function approvedDecision(): ApprovedDecision {
  return {
    schema_version: 1,
    record_type: 'approved_decision',
    refund_request_id: FIXTURE.refund_request_id,
    payment_id: FIXTURE.payment_id,
    decision: 'APPROVED',
    approved_amount_minor: FIXTURE.amount_minor,
    currency: FIXTURE.currency,
  };
}

export function trialMessage(): TrialMessage {
  return {
    schema_version: 1,
    record_type: 'trial_message',
    run_id: IDS.run,
    trial_id: IDS.trial3,
    trial_manifest_sha256: DIGESTS.trialManifest,
    payment_id: FIXTURE.payment_id,
    refund_request_id: FIXTURE.refund_request_id,
  };
}

/** A conventional caller's call inside the run's conventional COMMIT_THEN_TIMEOUT trial. */
export function trialProviderRefundCall(): ProviderRefundCall {
  return {
    schema_version: 1,
    record_type: 'provider_refund_call',
    caller_id: 'conventional',
    run_id: IDS.run,
    execution_manifest_sha256: DIGESTS.executionManifest,
    trial_id: IDS.trial3,
    trial_manifest_sha256: DIGESTS.trialManifest,
    attempt_id: IDS.attempt,
    provider_request_id: IDS.providerRequest,
    refund_request_id: FIXTURE.refund_request_id,
    payment_id: FIXTURE.payment_id,
    amount_minor: FIXTURE.amount_minor,
    currency: FIXTURE.currency,
  };
}

/** The probe caller's single call: no trial (D-06). */
export function probeProviderRefundCall(): ProviderRefundCall {
  return {
    schema_version: 1,
    record_type: 'provider_refund_call',
    caller_id: 'probe',
    transport_probe_id: IDS.transportProbe,
    execution_manifest_sha256: DIGESTS.executionManifest,
    attempt_id: IDS.attempt,
    provider_request_id: IDS.providerRequest,
    refund_request_id: FIXTURE.refund_request_id,
    payment_id: FIXTURE.payment_id,
    amount_minor: FIXTURE.amount_minor,
    currency: FIXTURE.currency,
  };
}

export function succeededResponse(): ProviderRefundSucceeded {
  return {
    schema_version: 1,
    record_type: 'provider_refund_response',
    outcome: 'SUCCEEDED',
    provider_call_id: IDS.providerCall,
    attempt_id: IDS.attempt,
    provider_request_id: IDS.providerRequest,
    provider_transaction_id: IDS.providerTransaction,
  };
}

/** A currency-mismatch rejection that echoes the structurally valid caller identities. */
export function rejectedResponse(): ProviderRefundRejected {
  return {
    schema_version: 1,
    record_type: 'provider_refund_response',
    outcome: 'REJECTED',
    provider_call_id: IDS.providerCall,
    attempt_id: IDS.attempt,
    provider_request_id: IDS.providerRequest,
    rejection_reason: 'CURRENCY_MISMATCH',
  };
}

export function probeWorkloadRequest(): ProbeWorkloadRequest {
  return {
    schema_version: 1,
    record_type: 'probe_workload_request',
    transport_probe_id: IDS.transportProbe,
    execution_manifest_sha256: DIGESTS.executionManifest,
    payment_id: FIXTURE.payment_id,
    refund_request_id: FIXTURE.refund_request_id,
    amount_minor: FIXTURE.amount_minor,
    currency: FIXTURE.currency,
  };
}
