// What trial execution (design §5.3 L5 `trial-execution/`, §10.2 P4 T1-T11) reads and writes
// through, and what it reports. The executor runs one declared trial of a run or a variant
// validation: it freezes the trial inputs, prepares the partitions, warms the provider, publishes
// the trial message, observes settlement, collects, rechecks and freezes the evidence. Every
// effect crosses one of these ports, so the offline cloud (test/support/offline-cloud) and the
// AWS composition root bind the same executor. Type-only: no runtime part (A-10).

import type { DurableItemStore } from '../durable-store/item-store-port.ts';
import type { AppendOnlyFile } from '../event-journal/append-only-file.ts';
import type { DlqReceiver } from '../evidence-collection/dlq-capture.ts';
import type { DurableExecutionReader } from '../evidence-collection/durable-metadata.ts';
import type { QueueCounterReader, QueueTarget } from '../evidence-collection/queue-observation.ts';
import type { TelemetryProbe } from '../evidence-collection/telemetry-availability.ts';
import type { PackageFileSystem } from '../evidence-package/package-file-system.ts';
import type { ProviderTransportResult } from '../provider-client/provider-invocation-port.ts';
import type {
  ExecutionIdentity,
  Scenario,
  Sha256Hex,
  Sleeper,
  StructuredReason,
  UuidSource,
  Uuid4,
  VariantId,
  WallClock,
} from '../record-contract/primitives.ts';
import type { ApprovedDecision } from '../record-contract/records/group-a/approved_decision.ts';
import type { Payment } from '../record-contract/records/group-a/payment.ts';
import type { ProviderWarmupRequest } from '../record-contract/records/group-b/provider_warmup_request.ts';
import type { InterruptionCause } from '../record-contract/records/group-b/vocabulary.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import type { SettlementAssessment } from '../settlement/settlement-policy.ts';

/** The executions that have trials: a run or a variant validation (a probe has none, D-06). */
export type TrialExecution = Extract<ExecutionIdentity, { readonly execution_kind: 'RUN' | 'VARIANT_VALIDATION' }>;

/** One trial as the frozen execution manifest declares it (BR-RUA-019). */
export interface DeclaredTrial {
  readonly trial_id: Uuid4;
  readonly sequence: number;
  readonly variant_id: VariantId;
  readonly scenario: Scenario;
}

/** The provider timing the trial configuration item carries (OR-RUA-002). */
export interface ProviderTiming {
  readonly safety_release_ms: number;
  readonly treatment_poll_interval_ms: number;
}

/** The Durable caller version whose executions a Durable trial lists (BR-RUA-037). */
export interface DurableCallerTarget {
  readonly function_arn: string;
  readonly qualifier: string;
}

/** Everything one trial needs from the frozen execution: identity, inputs and its resources. */
export interface TrialPlan {
  readonly execution: TrialExecution;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly resource_manifest_sha256: Sha256Hex;
  readonly trial: DeclaredTrial;
  readonly payment: Payment;
  readonly approved_decision: ApprovedDecision;
  readonly provider_timing: ProviderTiming;
  /** The provider's published version the warm-up must report as executed (BR-RUA-053). */
  readonly provider_version: string;
  /** The variant's source queue and its DLQ. */
  readonly queues: { readonly source: QueueTarget; readonly dlq: QueueTarget };
  /** Present for a Durable trial only. */
  readonly durable_caller?: DurableCallerTarget;
}

/** Why the active trial stopped early, as `trial_interrupted` records it (design §10.2). */
export interface TrialInterruption {
  readonly cause: InterruptionCause;
  readonly detail: string;
}

/**
 * The execution's view of the lease, the safety limits and the interruption sources (design
 * §5.3, §10.2 T5). Once an interruption is set, no trial starts and the active one is frozen.
 */
export interface PublicationGate {
  publicationAllowed(): boolean;
  mayStartTrial(): boolean;
  interruption(): TrialInterruption | undefined;
}

/** One SQS FIFO `SendMessage` of the trial message (BR-RUA-020: group and deduplication id = trial id). */
export interface TrialMessageSend {
  readonly queue_url: string;
  readonly body: string;
  readonly message_group_id: string;
  readonly message_deduplication_id: string;
}

/**
 * The outcome of one send: `sent` with what SQS returned, `rejected` when SQS definitively did
 * not accept it, `ambiguous` when the message may or may not be on the queue.
 */
export type TrialMessageSendOutcome =
  | {
      readonly kind: 'sent';
      readonly message_id: string;
      readonly sequence_number: string;
      readonly md5_of_message_body: string;
    }
  | { readonly kind: 'rejected'; readonly code: string }
  | { readonly kind: 'ambiguous'; readonly code: string };

/** Publishes trial messages (design §5.3; production: SQS `SendMessage`). */
export interface TrialMessagePublisher {
  publish(send: TrialMessageSend): Promise<TrialMessageSendOutcome>;
}

/** One synchronous Invoke of the provider's published version with the warm-up request (addendum §2). */
export interface ProviderWarmupInvoker {
  invokeWarmup(request: ProviderWarmupRequest): Promise<ProviderTransportResult>;
}

/** A structured JSON log line of trial execution: diagnostics, never evidence. */
export interface TrialExecutionLogLine {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly trial_id: Uuid4;
  readonly detail: string;
}

export type TrialExecutionLogSink = (line: TrialExecutionLogLine) => void;

/** The ports and services the executor runs on. */
export interface TrialExecutorDeps {
  readonly store: DurableItemStore;
  readonly queues: QueueCounterReader;
  readonly dlq: DlqReceiver;
  readonly durable: DurableExecutionReader;
  readonly telemetry: TelemetryProbe;
  readonly publisher: TrialMessagePublisher;
  readonly warmup: ProviderWarmupInvoker;
  /** The evidence file system; the executor writes under the execution's package directory. */
  readonly files: PackageFileSystem;
  /** The medium of the runner journal, the same storage `files` reads it back from. */
  readonly runner_journal: AppendOnlyFile;
  readonly clock: WallClock;
  readonly sleeper: Sleeper;
  readonly ids: UuidSource;
  readonly validator: RecordValidator;
  readonly log: TrialExecutionLogSink;
}

/** A trial that never published: setup was rejected or the gate refused (no trial started). */
export interface TrialNotStarted {
  readonly kind: 'not_started';
  readonly trial_id: Uuid4;
  readonly reasons: readonly StructuredReason[];
}

/** A published trial whose evidence was frozen, settled or not (D-29). */
export interface TrialFrozen {
  readonly kind: 'frozen';
  readonly trial_id: Uuid4;
  readonly settlement: SettlementAssessment;
  readonly interruption?: TrialInterruption;
  readonly evidence_index_path: string;
  readonly evidence_index_sha256: Sha256Hex;
  /** Collection, evaluation and journal problems that did not stop the freeze. */
  readonly failures: readonly StructuredReason[];
}

/** A published trial whose evidence index could not be written. */
export interface TrialFreezeFailed {
  readonly kind: 'freeze_failed';
  readonly trial_id: Uuid4;
  readonly reasons: readonly StructuredReason[];
}

export type TrialExecutionReport = TrialNotStarted | TrialFrozen | TrialFreezeFailed;
