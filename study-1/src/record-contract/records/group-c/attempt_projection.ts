// Catalogue group C row 66 (design §6.2, §8.9): the derived per-attempt view of one trial or
// probe. It is never fed back into a verdict (BR-RUA-037, BR-RUA-021, BR-RUA-022).

import type { EvidenceRef } from '../../evidence-refs.ts';
import type { DecimalString, Uuid4, UtcMillis } from '../../primitives.ts';
import type {
  AttemptOutcome,
  CallerEventSource,
  DispatchState,
  DurableExecutionStatus,
  EffectKnowledge,
  ProviderRejectionReason,
  TransportSettlementKind,
} from '../group-b/vocabulary.ts';
import type { ExecutionCorrelation, ExecutionScoped, TrialScoped } from './shared-shapes.ts';
import type { OutcomeClass } from './vocabulary.ts';

/** The caller invocation an attempt ran in (BR-RUA-020, BR-RUA-024). */
export interface ProjectedInvocation {
  readonly source: CallerEventSource;
  readonly source_instance_id: Uuid4;
  readonly message_id?: string;
  readonly receive_count?: number;
  readonly durable_execution_arn?: string;
  readonly step_attempt?: number;
}

/** A transport settlement recorded after the timer won; the payload was never parsed (D-26). */
export interface ProjectedLateSettlement {
  readonly settlement_kind: TransportSettlementKind;
  readonly observed_after_elapsed_ns: DecimalString;
}

/** One physical attempt. `outcome` is omitted for a dispatched attempt that never recorded one. */
export interface ProjectedAttempt {
  readonly attempt_id: Uuid4;
  readonly provider_request_id: Uuid4;
  readonly refund_request_id: string;
  readonly registered_event_id: Uuid4;
  readonly invocation: ProjectedInvocation;
  readonly dispatch_state: DispatchState;
  readonly outcome?: AttemptOutcome;
  readonly outcome_class: OutcomeClass;
  readonly provider_call_id?: Uuid4;
  /** Joined through the provider commit event, never through the caller (design §8.9). */
  readonly provider_transaction_id?: Uuid4;
  readonly late_transport_settlement?: ProjectedLateSettlement;
  readonly knowledge_after_derived: EffectKnowledge;
  /** Omitted when no request state was recorded after the attempt. */
  readonly knowledge_after_recorded?: EffectKnowledge;
}

interface ProjectedCallHead {
  readonly provider_call_id: Uuid4;
  readonly received_event_id: Uuid4;
}

/** Every received provider call, rejected ones included (design §8.9). */
export type ProjectedProviderCall =
  | (ProjectedCallHead & {
      readonly disposition: 'ACCEPTED';
      readonly attempt_id: Uuid4;
      readonly provider_request_id: Uuid4;
    })
  | (ProjectedCallHead & { readonly disposition: 'REJECTED'; readonly rejection_reason: ProviderRejectionReason })
  | (ProjectedCallHead & { readonly disposition: 'UNRESOLVED' });

/** A ledger transaction by reference: identities and a pointer, never a copy of the item (BR-RUA-037). */
export interface ProjectedTransaction {
  readonly provider_transaction_id: Uuid4;
  readonly provider_commit_id: Uuid4;
  readonly provider_call_id: Uuid4;
  readonly ledger_ref: EvidenceRef;
}

/** Every durable execution listed in the execution metadata (AC-RUA-003). */
export interface ProjectedDurableExecution {
  readonly durable_execution_arn: string;
  readonly status: DurableExecutionStatus;
}

interface AttemptProjectionFields {
  readonly schema_version: 1;
  readonly record_type: 'attempt_projection';
  readonly attempts: readonly ProjectedAttempt[];
  readonly provider_calls: readonly ProjectedProviderCall[];
  readonly transactions: readonly ProjectedTransaction[];
  readonly durable_executions: readonly ProjectedDurableExecution[];
  readonly derived_at: UtcMillis;
}

/** Schema: `schemas/group-c/attempt_projection.schema.json`. A probe projection has no trial identity. */
export type AttemptProjection = ExecutionCorrelation & AttemptProjectionFields & (TrialScoped | ExecutionScoped);
