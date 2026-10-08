// Canonical provider-journal examples (catalogue rows 29-38 plus the warm-up pair, addendum
// §3): the targeted commit of `COMMIT_TRIPLE` held under COMMIT_THEN_TIMEOUT and released after
// the controller's timeout signal (BR-RUA-022..027).

import type { ProviderCallAccepted } from '../../../../../src/record-contract/records/group-b/provider_call_accepted.ts';
import type { ProviderCallReceived } from '../../../../../src/record-contract/records/group-b/provider_call_received.ts';
import type { ProviderCallRejected } from '../../../../../src/record-contract/records/group-b/provider_call_rejected.ts';
import type { ProviderCommitConfirmed } from '../../../../../src/record-contract/records/group-b/provider_commit_confirmed.ts';
import type { ProviderCommitFailed } from '../../../../../src/record-contract/records/group-b/provider_commit_failed.ts';
import type { ProviderResponseReturned } from '../../../../../src/record-contract/records/group-b/provider_response_returned.ts';
import type { ProviderTransactionCommitted } from '../../../../../src/record-contract/records/group-b/provider_transaction_committed.ts';
import type { ProviderWarmupCompleted } from '../../../../../src/record-contract/records/group-b/provider_warmup_completed.ts';
import type { ProviderWarmupRequest } from '../../../../../src/record-contract/records/group-b/provider_warmup_request.ts';
import type { TreatmentResponseReleased } from '../../../../../src/record-contract/records/group-b/treatment_response_released.ts';
import type {
  ArmedSafetyRelease,
  CommittedSafetyRelease,
} from '../../../../../src/record-contract/records/group-b/treatment_safety_released.ts';
import type { TreatmentTimeoutObserved } from '../../../../../src/record-contract/records/group-b/treatment_timeout_observed.ts';
import {
  ATTEMPT_CORRELATION,
  COMMIT_TRIPLE,
  EXECUTION_MANIFEST_SHA256,
  PAYMENT_ID,
  RUN_ID,
  TRIAL_ID,
  at,
  digest,
  executionEnvelope,
  ns,
  trialEnvelope,
  uuid,
} from '../../../../support/record-contract/record-builders.ts';
import { example } from '../support/record-example.ts';
import type { RecordExample } from '../support/record-example.ts';

const WARMUP_ID = uuid(0x500);
const SIGNAL_EVENT_ID = uuid(23);
const OBSERVED_EVENT_ID = uuid(17);

/**
 * The provider's first record of a call: identities copied verbatim before validation.
 *
 * @example
 * toJson(providerCallReceived());
 */
export function providerCallReceived(): ProviderCallReceived {
  return {
    ...trialEnvelope('provider_call_received', 11, 1),
    source: 'refund_provider',
    provider_call_id: COMMIT_TRIPLE.provider_call_id,
    raw_request_sha256: digest('raw-request'),
    caller_id: 'conventional',
    attempt_id: ATTEMPT_CORRELATION.attempt_id,
    provider_request_id: ATTEMPT_CORRELATION.provider_request_id,
    refund_request_id: ATTEMPT_CORRELATION.refund_request_id,
    payment_id: PAYMENT_ID,
  };
}

/**
 * A call the provider refused before any ledger write.
 *
 * @example
 * toJson(providerCallRejected());
 */
export function providerCallRejected(): ProviderCallRejected {
  return {
    ...trialEnvelope('provider_call_rejected', 12, 2),
    source: 'refund_provider',
    provider_call_id: COMMIT_TRIPLE.provider_call_id,
    reason: 'AMOUNT_INVALID',
    detail: 'amount_minor 0 is not positive; expected a positive safe integer',
  };
}

/**
 * A validated call, before the commit plan.
 *
 * @example
 * toJson(providerCallAccepted());
 */
export function providerCallAccepted(): ProviderCallAccepted {
  return {
    ...trialEnvelope('provider_call_accepted', 13, 2),
    source: 'refund_provider',
    provider_call_id: COMMIT_TRIPLE.provider_call_id,
    caller_id: 'conventional',
    ...ATTEMPT_CORRELATION,
    payment_id: PAYMENT_ID,
    amount_minor: 1250,
    currency: 'EUR',
  };
}

/**
 * The ledger commit of the targeted attempt.
 *
 * @example
 * toJson(providerTransactionCommitted());
 */
export function providerTransactionCommitted(): ProviderTransactionCommitted {
  return {
    ...trialEnvelope('provider_transaction_committed', 14, 3),
    source: 'refund_provider',
    ...ATTEMPT_CORRELATION,
    ...COMMIT_TRIPLE,
    payment_id: PAYMENT_ID,
    amount_minor: 1250,
    currency: 'EUR',
    targeted: true,
    commit_requested_at: at(20),
  };
}

/**
 * The read-back confirmation of the commit.
 *
 * @example
 * toJson(providerCommitConfirmed());
 */
export function providerCommitConfirmed(): ProviderCommitConfirmed {
  return {
    ...trialEnvelope('provider_commit_confirmed', 15, 4),
    source: 'refund_provider',
    ...COMMIT_TRIPLE,
    committed_at: at(21),
  };
}

/**
 * A commit the ledger refused.
 *
 * @example
 * toJson(providerCommitFailed());
 */
export function providerCommitFailed(): ProviderCommitFailed {
  return {
    ...trialEnvelope('provider_commit_failed', 16, 4),
    source: 'refund_provider',
    ...COMMIT_TRIPLE,
    targeted: false,
    error_code: 'TransactionCanceledException',
    detail: 'ConditionalCheckFailed on the payment item; expected the refund to fit',
  };
}

/**
 * The held call observing the controller's timeout signal.
 *
 * @example
 * toJson(treatmentTimeoutObserved());
 */
export function treatmentTimeoutObserved(): TreatmentTimeoutObserved {
  return {
    ...trialEnvelope('treatment_timeout_observed', 17, 5),
    source: 'refund_provider',
    causation_event_ids: [SIGNAL_EVENT_ID],
    provider_commit_id: COMMIT_TRIPLE.provider_commit_id,
    provider_call_id: COMMIT_TRIPLE.provider_call_id,
    attempt_id: ATTEMPT_CORRELATION.attempt_id,
    signal_event_id: SIGNAL_EVENT_ID,
  };
}

/**
 * The held response released after the observation.
 *
 * @example
 * toJson(treatmentResponseReleased());
 */
export function treatmentResponseReleased(): TreatmentResponseReleased {
  return {
    ...trialEnvelope('treatment_response_released', 18, 6),
    source: 'refund_provider',
    causation_event_ids: [OBSERVED_EVENT_ID],
    provider_commit_id: COMMIT_TRIPLE.provider_commit_id,
    provider_call_id: COMMIT_TRIPLE.provider_call_id,
    attempt_id: ATTEMPT_CORRELATION.attempt_id,
  };
}

/**
 * A safety release of a committed, still-held treatment.
 *
 * @example
 * toJson(committedSafetyRelease());
 */
export function committedSafetyRelease(): CommittedSafetyRelease {
  return {
    ...trialEnvelope('treatment_safety_released', 19, 6),
    source: 'refund_provider',
    cause: 'SAFETY_DEADLINE',
    from_state: 'COMMITTED_WAITING',
    provider_commit_id: COMMIT_TRIPLE.provider_commit_id,
    provider_call_id: COMMIT_TRIPLE.provider_call_id,
    attempt_id: ATTEMPT_CORRELATION.attempt_id,
    elapsed_since_commit_ns: ns(30_000_000_000n),
  };
}

/**
 * A safety release of a treatment that never committed.
 *
 * @example
 * toJson(armedSafetyRelease());
 */
export function armedSafetyRelease(): ArmedSafetyRelease {
  return {
    ...trialEnvelope('treatment_safety_released', 19, 6),
    source: 'refund_provider',
    cause: 'CLEANUP_REQUEST',
    from_state: 'ARMED',
  };
}

/**
 * The provider's response to the caller after release.
 *
 * @example
 * toJson(providerResponseReturned());
 */
export function providerResponseReturned(): ProviderResponseReturned {
  return {
    ...trialEnvelope('provider_response_returned', 20, 7),
    source: 'refund_provider',
    ...COMMIT_TRIPLE,
    attempt_id: ATTEMPT_CORRELATION.attempt_id,
    provider_request_id: ATTEMPT_CORRELATION.provider_request_id,
  };
}

/**
 * A completed readiness warm-up call (execution level, never a trial).
 *
 * @example
 * toJson(providerWarmupCompleted());
 */
export function providerWarmupCompleted(): ProviderWarmupCompleted {
  return {
    ...executionEnvelope('provider_warmup_completed', 'run', 21, 8),
    source: 'refund_provider',
    provider_call_id: uuid(0x403),
    warmup_id: WARMUP_ID,
    received_at: at(5),
    completed_at: at(6),
    handler_elapsed_ns: ns(1_200_000n),
  };
}

/**
 * The warm-up request body; `trial_id` may correlate it but no trial digest is carried.
 *
 * @example
 * toJson(providerWarmupRequest());
 */
export function providerWarmupRequest(): ProviderWarmupRequest {
  return {
    schema_version: 1,
    record_type: 'provider_warmup_request',
    run_id: RUN_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    warmup_id: WARMUP_ID,
    trial_id: TRIAL_ID,
  };
}

const VERBATIM_IDENTITIES = ['caller_id', 'attempt_id', 'provider_request_id', 'refund_request_id', 'payment_id'];

export const PROVIDER_EXAMPLES: readonly RecordExample[] = [
  example('provider_call_received', providerCallReceived(), {
    optional: VERBATIM_IDENTITIES,
    verbatim: VERBATIM_IDENTITIES,
  }),
  example('provider_call_rejected', providerCallRejected()),
  example('provider_call_accepted', providerCallAccepted()),
  example('provider_transaction_committed', providerTransactionCommitted()),
  example('provider_commit_confirmed', providerCommitConfirmed()),
  example('provider_commit_failed', providerCommitFailed()),
  example('treatment_timeout_observed', treatmentTimeoutObserved()),
  example('treatment_response_released', treatmentResponseReleased()),
  example('treatment_safety_released COMMITTED_WAITING', committedSafetyRelease(), {
    optional: ['elapsed_since_commit_ns'],
  }),
  example('treatment_safety_released ARMED', armedSafetyRelease()),
  example('provider_response_returned', providerResponseReturned()),
  example('provider_warmup_completed', providerWarmupCompleted()),
  example('provider_warmup_request', providerWarmupRequest(), { optional: ['trial_id'] }),
];
