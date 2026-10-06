// The ports the execution runner acts through (design §10.2 P1-P9, §5.3 `ExecutionRunner`). The
// runner owns the phase order, the publication gate and the interruption sources; every cloud
// effect goes through a port the composition root binds (the AWS bindings of provisioning and
// readiness are not part of this feature, evidence/WP-27/decisions.md). Type-only: no runtime code
// (A-10).

import type { CleanupPorts } from '../cleanup/cleanup-orchestrator.ts';
import type { LeaseLoss } from '../coordination-lease/lease-session.ts';
import type { LeaseClosure } from '../coordination-lease/lease-finalization.ts';
import type { DurableItemStore } from '../durable-store/item-store-port.ts';
import type { AppendOnlyFile } from '../event-journal/append-only-file.ts';
import type { DurableExecutionReader } from '../evidence-collection/durable-metadata.ts';
import type { QueueCounterReader, QueueTarget } from '../evidence-collection/queue-observation.ts';
import type { PackageFileSystem } from '../evidence-package/package-file-system.ts';
import type {
  ExecutionIdentity,
  MonotonicClock,
  Sha256Hex,
  Sleeper,
  StructuredReason,
  UuidSource,
  VariantId,
  WallClock,
} from '../record-contract/primitives.ts';
import type { ExecutionManifest } from '../record-contract/records/group-a/execution_manifest.ts';
import type { ResourceManifest } from '../record-contract/records/group-a/resource_manifest.ts';
import type { SafetyCheck } from '../record-contract/records/group-c/safety_assessment.ts';
import type { LeaseStatus } from '../record-contract/records/group-c/vocabulary.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import type {
  DurableCallerTarget,
  PublicationGate,
  TrialExecution,
  TrialExecutionReport,
  TrialInterruption,
  TrialPlan,
} from '../trial-execution/trial-execution-ports.ts';

/** An admitted execution: its frozen manifest, the digest of those exact bytes, and its package. */
export interface AdmittedExecution {
  readonly manifest: ExecutionManifest;
  readonly manifest_sha256: Sha256Hex;
  readonly identity: ExecutionIdentity;
  /** `runs/<run_id>`, `variant-validations/<id>` or `transport-probes/<id>`, below the evidence root. */
  readonly package_directory: string;
}

/** An admitted run or variant validation: the executions that have trials (a probe has none). */
export type AdmittedTrialExecution = AdmittedExecution & { readonly identity: TrialExecution };

/** One variant's source queue and its dead-letter queue. */
export interface VariantQueues {
  readonly source: QueueTarget;
  readonly dlq: QueueTarget;
}

/** What the deployed stack names, as trials, readiness and cleanup address it. */
export interface ExecutionTargets {
  /** The provider's published version (BR-RUA-053). */
  readonly provider_version: string;
  /** The queues of every deployed variant. */
  readonly queues: Readonly<Partial<Record<VariantId, VariantQueues>>>;
  /** The Durable caller version, when the Durable variant is deployed. */
  readonly durable_caller?: DurableCallerTarget;
  /** Event-source mappings of both sources and the controller stream (readiness, cleanup step 3). */
  readonly event_source_mapping_ids: readonly string[];
  /** Functions whose running Durable executions cleanup stops (step 5, RK-10). */
  readonly durable_function_names: readonly string[];
}

/**
 * P2 (design §9.8 D1-D4): the deployment always leaves `provisioning/resource-manifest.json`
 * behind, `failed` or `partial` when the deploy did not complete, so cleanup knows what it owns.
 */
export interface ProvisioningOutcome {
  readonly resource_manifest: ResourceManifest;
  readonly resource_manifest_sha256: Sha256Hex;
  /** Present exactly when the deploy succeeded and the outputs name every target. */
  readonly targets?: ExecutionTargets;
  readonly reasons: readonly StructuredReason[];
}

/** Deploys the frozen assembly and writes the resource manifest (P2). */
export interface ExecutionProvisioner {
  provision(admitted: AdmittedExecution): Promise<ProvisioningOutcome>;
}

/** Runs one declared trial (P4, `TrialExecutor` in production). */
export interface TrialRunner {
  execute(plan: TrialPlan, gate: PublicationGate): Promise<TrialExecutionReport>;
}

/** The coordination lease as the runner uses it (P1, the heartbeat beside P2-P8, P8). */
export interface ExecutionLease {
  acquire(): Promise<{ readonly acquired: true } | { readonly acquired: false; readonly reason: StructuredReason }>;
  publicationAllowed(): boolean;
  startHeartbeats(onLoss: (loss: LeaseLoss) => void): void;
  stopHeartbeats(): void;
  finalize(closure: LeaseClosure): Promise<LeaseStatus>;
}

/** The safety supervisor's view the runner needs (BR-RUA-046, AC-RUA-049). */
export interface ExecutionSafety {
  mayStartTrial(): boolean;
  activeDeadlineReached(): boolean;
  totalTargetExceeded(): boolean;
  markActiveEnded(): void;
  checks(): readonly SafetyCheck[];
}

/** Starts supervision at the monotonic reading taken when the first mutation began. */
export type ExecutionSafetyFactory = (startedNs: bigint, admitted: AdmittedExecution) => ExecutionSafety;

/** The cleanup ports the composition root binds; the runner adds evidence, journal and safety. */
export type CleanupBindings = Omit<CleanupPorts, 'evidence' | 'journal' | 'safety' | 'clock'>;

/** The reads of the execution-level and pre-cleanup evidence (design §7 `readiness/`, `cleanup/`). */
export interface ExecutionEvidenceReaders {
  readonly store: DurableItemStore;
  readonly queues: QueueCounterReader;
  readonly durable: DurableExecutionReader;
}

/** The evidence root: write-once package files and the JSONL journals beside them. */
export interface EvidenceRoot {
  readonly files: PackageFileSystem;
  readonly journals: AppendOnlyFile;
}

/** One structured log line of the runner (plain text never reaches stdout). */
export interface ExecutionLogLine {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly detail: string;
}

export type ExecutionLogSink = (line: ExecutionLogLine) => void;

/** The services every runner component shares. */
export interface ExecutionServices {
  readonly clock: WallClock;
  readonly monotonic: MonotonicClock;
  readonly sleeper: Sleeper;
  readonly ids: UuidSource;
  readonly validator: RecordValidator;
  readonly log: ExecutionLogSink;
}

/** How one execution ended, for the operator CLI's exit code (design §11). */
export interface ExecutionOutcome {
  /** True once `package-index.json` was written last. */
  readonly package_finalized: boolean;
  readonly interruption?: TrialInterruption;
  readonly trials: readonly TrialExecutionReport[];
  readonly cleanup_status?: string;
  readonly leak_audit_status?: string;
  readonly lease_status?: LeaseStatus;
  readonly reasons: readonly StructuredReason[];
}
