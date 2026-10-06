// The typed evidence model of design §5.3 `evidence-ingestion/` (WP-12): what ingestion receives
// (exact artifact bytes plus the expected artifact set) and what it hands to the oracle, the
// treatment-fidelity conditions and the probe verdict. Type-only: no runtime code (A-10).
//
// Origins: `subject` artifacts are the expected files of the trial or probe being evaluated
// (design §8.1 expected artifact set); `supplementary` artifacts are other execution-level files
// given with them, such as the A-09 `<execution_id>#provider` partition and the addendum §2
// warm-up journal, which are evidence of stray calls and readiness and never verdict-critical;
// `execution_scope` artifacts are earlier trials' journals and ledgers, read only to resolve
// causation and the INV-RUA-001 identity scope.

import type { EventSource } from '../record-contract/envelope.ts';
import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import type {
  ExecutionIdentity,
  GateValue,
  JsonValue,
  Scenario,
  Sha256Hex,
  StructuredReason,
  Uuid4,
  VariantId,
} from '../record-contract/primitives.ts';
import type { ApprovedDecision } from '../record-contract/records/group-a/approved_decision.ts';
import type { ExecutionManifest } from '../record-contract/records/group-a/execution_manifest.ts';
import type { Payment } from '../record-contract/records/group-a/payment.ts';
import type { ProviderTrialConfiguration } from '../record-contract/records/group-a/provider_trial_configuration.ts';
import type { ResourceManifest } from '../record-contract/records/group-a/resource_manifest.ts';
import type { TrialManifest } from '../record-contract/records/group-a/trial_manifest.ts';
import type { TrialMessage } from '../record-contract/records/group-a/trial_message.ts';
import type { TrialRegistration } from '../record-contract/records/group-a/trial_registration.ts';
import type { DlqSnapshot } from '../record-contract/records/group-b/dlq_snapshot.ts';
import type { DurableExecutionMetadata } from '../record-contract/records/group-b/durable_execution_metadata.ts';
import type { LedgerSnapshot, LedgerTransaction } from '../record-contract/records/group-b/ledger_snapshot.ts';
import type { QueueObservation } from '../record-contract/records/group-b/queue_observation.ts';
import type { SettlementSample } from '../record-contract/records/group-b/settlement_sample.ts';
import type { TelemetryAvailabilityRecord } from '../record-contract/records/group-b/telemetry_availability.ts';
import type { TreatmentStateSnapshot } from '../record-contract/records/group-b/treatment_state_snapshot.ts';
import type { ArtifactClass, GateId, IngestionFindingCode } from '../record-contract/records/group-c/vocabulary.ts';
import type { JournalEvent } from '../event-journal/journal-event.ts';

/** Exact bytes of one file at its normalized package-relative POSIX path. */
export interface RawArtifact {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export type ArtifactRequirement = 'required' | 'conditional' | 'optional';

/** One artifact the evaluation expects (evidence-package `expectedArtifactsFor`). */
export interface ExpectedArtifact {
  readonly path: string;
  readonly artifact_class: ArtifactClass;
  readonly requirement: ArtifactRequirement;
}

export interface IngestionInput {
  /** The subject's trial or probe files, the execution-level core files and any supplementary execution-level journal. */
  readonly artifacts: readonly RawArtifact[];
  readonly expected: readonly ExpectedArtifact[];
  /** Earlier trials' journals and ledger snapshots of the same execution (INV-RUA-001 scope). */
  readonly execution_scope_artifacts: readonly RawArtifact[];
  /** Present when a frozen package is re-evaluated: the evidence index's digest of each path. */
  readonly indexed_digests?: ReadonlyMap<string, Sha256Hex>;
}

export type ArtifactOrigin = 'subject' | 'supplementary' | 'execution_scope';

/**
 * `correlation_missing`: the record's only schema faults are absent correlation fields, or it is
 * a subject trial record without a trial identity (design §8.2 I2, AC-RUA-041 case 1).
 */
export type RecordValidity = 'valid' | 'schema_invalid' | 'correlation_missing';

/** One JSON document or JSONL line of an artifact. */
export interface IngestedRecord {
  readonly artifact_path: string;
  /** 1-based JSONL line; absent for a JSON document. */
  readonly line_number?: number;
  readonly value: JsonValue;
  readonly validity: RecordValidity;
}

export interface IngestedArtifact {
  readonly path: string;
  readonly sha256: Sha256Hex;
  readonly byte_length: number;
  readonly origin: ArtifactOrigin;
  /** Present for expected artifacts. */
  readonly artifact_class?: ArtifactClass;
  readonly requirement?: ArtifactRequirement;
  readonly parse_status: 'parsed' | 'unparseable';
  /** Every document or line that parsed, in file order: an unparseable JSONL file keeps its good lines. */
  readonly records: readonly IngestedRecord[];
}

/**
 * One BR-RUA-034 classification. Findings are aggregated per artifact, source instance or event,
 * so their number is bounded by the evidence's structure and each detail is bounded text
 * (Owner amendment A-12): `occurrences` counts what one finding stands for.
 */
export interface IngestionFinding extends StructuredReason {
  readonly code: IngestionFindingCode;
  readonly occurrences: number;
  /** `<source>#<source_instance_id>` for sequence findings. */
  readonly source_instance_key?: string;
}

/** A parsed record of a known type, with where it was read from. */
export interface LocatedRecord<T> {
  readonly record: T;
  readonly artifact_path: string;
  readonly artifact_sha256: Sha256Hex;
  readonly line_number?: number;
  readonly origin: ArtifactOrigin;
  /** True when only correlation fields are absent; those fields then read as `undefined`. */
  readonly correlation_missing: boolean;
}

/** One journal event after BR-RUA-034 duplicate collapse. */
export interface IndexedEvent extends LocatedRecord<JournalEvent> {
  /** `trial_id` of the event, or `execution` for an execution-level event. */
  readonly partition: string;
  /** How many structurally equivalent copies were read (1 when unique). */
  readonly copies: number;
}

/** The density state of one `(source, source_instance_id)`. */
export interface SourceInstanceView {
  readonly key: string;
  readonly source: EventSource;
  readonly source_instance_id: Uuid4;
  readonly max_sequence: number;
  readonly missing_sequences: number;
  readonly conflicting_sequences: number;
  /** A gapped instance makes every check relying on it indeterminate (BR-RUA-034). */
  readonly gapped: boolean;
}

export interface EventIndex {
  /** Every indexed event of every origin, by `event_id` (the first copy wins a content conflict). */
  readonly by_id: ReadonlyMap<string, IndexedEvent>;
  /** The subject's events in artifact and line order. */
  readonly subject: readonly IndexedEvent[];
  /** Subject and supplementary instances, by `<source>#<source_instance_id>`. */
  readonly instances: ReadonlyMap<string, SourceInstanceView>;
  readonly conflicting_event_ids: ReadonlySet<string>;
  /** Event id of a subject or supplementary event to its causal predecessors that do not resolve. */
  readonly unresolved_causation: ReadonlyMap<string, readonly string[]>;
}

export type LedgerStatus = 'present' | 'missing' | 'unusable';

/** The subject's ledger snapshot after design §8.2 I7; transactions are never truncated. */
export interface LedgerView {
  readonly status: LedgerStatus;
  readonly snapshot?: LocatedRecord<LedgerSnapshot>;
  readonly transactions: readonly LedgerTransaction[];
  readonly duplicate_transaction_ids: readonly string[];
  /** True only when the snapshot declares completion and its pages prove it. */
  readonly pagination_complete: boolean;
  readonly pagination_problems: readonly string[];
}

/** The subject's single-record documents and observation streams, valid records only. */
export interface ObservationView {
  readonly execution_manifest?: LocatedRecord<ExecutionManifest>;
  readonly resource_manifest?: LocatedRecord<ResourceManifest>;
  readonly trial_manifest?: LocatedRecord<TrialManifest>;
  readonly payment?: LocatedRecord<Payment>;
  readonly approved_decision?: LocatedRecord<ApprovedDecision>;
  readonly published_message?: LocatedRecord<TrialMessage>;
  readonly provider_configuration?: LocatedRecord<ProviderTrialConfiguration>;
  readonly treatment_snapshot?: LocatedRecord<TreatmentStateSnapshot>;
  readonly trial_registration?: LocatedRecord<TrialRegistration>;
  readonly dlq_snapshot?: LocatedRecord<DlqSnapshot>;
  readonly durable_executions?: LocatedRecord<DurableExecutionMetadata>;
  readonly telemetry?: LocatedRecord<TelemetryAvailabilityRecord>;
  readonly settlement_samples: readonly LocatedRecord<SettlementSample>[];
  readonly source_observations: readonly LocatedRecord<QueueObservation>[];
  readonly dlq_observations: readonly LocatedRecord<QueueObservation>[];
}

/** The trial under evaluation, as its frozen manifest declares it. */
export interface SubjectTrial {
  readonly trial_id: Uuid4;
  /** The SHA-256 of the trial manifest's exact bytes. */
  readonly trial_manifest_sha256: Sha256Hex;
  readonly variant_id: VariantId;
  readonly scenario: Scenario;
  readonly sequence: number;
}

/** Who is evaluated: a trial of a run or validation, or the transport probe (D-06). */
export interface EvidenceScope {
  readonly subject_kind: 'trial' | 'probe';
  /** Absent when the execution manifest is missing or unusable. */
  readonly execution?: ExecutionIdentity;
  /** The SHA-256 of the execution manifest's exact bytes. */
  readonly execution_manifest_sha256?: Sha256Hex;
  readonly trial?: SubjectTrial;
  /** True when a frozen package is re-evaluated against its evidence index. */
  readonly reevaluation: boolean;
}

/** The INV-RUA-001 physical identities plus the BR-RUA-025 commit id the provider generates. */
export type IdentityKind =
  'attempt_id' | 'provider_request_id' | 'provider_call_id' | 'provider_transaction_id' | 'provider_commit_id';

/** One identity used by more than one origin event or across partitions (INV-RUA-001). */
export interface IdentityCollision {
  readonly kind: IdentityKind;
  readonly id: string;
  readonly origin_event_ids: readonly string[];
  readonly partitions: readonly string[];
  readonly refs: readonly EvidenceRef[];
}

/** Design §8.2 I8: the execution-scope identity registry, judged for the subject. */
export interface IdentityRegistry {
  /** Caller-generated reuse (`attempt_id`, `provider_request_id`): identity integrity invalid. */
  readonly caller_collisions: readonly IdentityCollision[];
  /** Provider-generated reuse (call, transaction, commit): evidence integrity invalid. */
  readonly provider_collisions: readonly IdentityCollision[];
  /** Subject attempt references with no `attempt_registered`: identity evidence missing. */
  readonly unregistered_attempts: readonly { readonly attempt_id: string; readonly ref: EvidenceRef }[];
}

export interface IngestedEvidence {
  readonly scope: EvidenceScope;
  /** The expected artifact set the evidence was ingested against. */
  readonly expected: readonly ExpectedArtifact[];
  readonly artifacts: ReadonlyMap<string, IngestedArtifact>;
  readonly events: EventIndex;
  readonly ledger: LedgerView;
  readonly observations: ObservationView;
  readonly identities: IdentityRegistry;
  readonly findings: readonly IngestionFinding[];
  readonly diagnostics: { readonly collapsed_duplicate_count: number };
  /** The evidence index digests given for a re-evaluation, unchanged. */
  readonly indexed_digests?: ReadonlyMap<string, Sha256Hex>;
}

/** One validity gate's value with its reasons and references (design §5.3). */
export interface GateAssessment<G extends GateId> {
  readonly gate: G;
  readonly value: GateValue;
  readonly reasons: readonly StructuredReason[];
  readonly evidence_refs: readonly EvidenceRef[];
}
