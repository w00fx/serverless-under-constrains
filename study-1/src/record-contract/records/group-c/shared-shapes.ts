// Field groups that several group-C records repeat. The JSON Schemas restate them per file
// (a record schema may reference only `_defs.schema.json` and its own `$defs`), so these
// types are the one place TypeScript names each group.

import type { EvidenceRef } from '../../evidence-refs.ts';
import type { JsonValue, Scenario, Sha256Hex, StructuredReason, Uuid4, VariantId } from '../../primitives.ts';
import type {
  ArtifactClass,
  ArtifactDerivation,
  ConditionId,
  IngestionFindingCode,
  PreservationVerdict,
  TrialExecutionStatus,
} from './vocabulary.ts';

export type { ExecutionCorrelation, ExecutionScoped, TrialScoped } from '../group-b/shared-shapes.ts';

/**
 * The execution of a trial: a run or a variant validation, never both and never a probe (D-06).
 * The `?: never` members make a record that names both identities a compile error, the same
 * exclusion the schemas' `oneOf` enforces at runtime.
 *
 * @example
 * const identity: TrialExecutionIdentity = { run_id: RUN_ID };
 */
export type TrialExecutionIdentity =
  | { readonly run_id: Uuid4; readonly variant_validation_id?: never; readonly transport_probe_id?: never }
  | { readonly variant_validation_id: Uuid4; readonly run_id?: never; readonly transport_probe_id?: never };

/** A package-relative path plus the exact digest of the stored bytes (CTR-RUA-001 `ledger_snapshot_ref`). */
export interface ArtifactRef {
  readonly artifact_path: string;
  readonly artifact_sha256: Sha256Hex;
}

/** A reference into another package: BR-RUA-035 requires its package-index digest. */
export type CrossPackageRef = EvidenceRef & { readonly package_index_sha256: Sha256Hex };

/** One file listed by an evidence, package or amendment index (design §7). */
export interface IndexEntry {
  readonly artifact_path: string;
  readonly artifact_class: ArtifactClass;
  readonly derivation: ArtifactDerivation;
  readonly bytes: number;
  readonly sha256: Sha256Hex;
}

/** One of BR-RUA-010..015 with its structured values (BR-RUA-027, design §5.3 `ConditionResult`). */
export interface ConditionResult {
  readonly condition_id: ConditionId;
  readonly result: PreservationVerdict;
  readonly expected: JsonValue;
  readonly observed: JsonValue;
  readonly evidence_refs: readonly EvidenceRef[];
  readonly indeterminate_reasons: readonly StructuredReason[];
  /** The ingestion findings that downgrade a would-be `fail` (design §8.10 "unaffected"). */
  readonly affected_by: readonly IngestionFindingCode[];
}

/** The six conditions in their fixed order. */
export type SixConditionResults = readonly [
  ConditionResult,
  ConditionResult,
  ConditionResult,
  ConditionResult,
  ConditionResult,
  ConditionResult,
];

interface TrialResultHead {
  readonly sequence: number;
  readonly trial_id: Uuid4;
  readonly variant_id: VariantId;
  readonly scenario: Scenario;
}

/** A summary entry of a trial that has an oracle result (design §6.3). */
export interface EvaluatedTrialResult extends TrialResultHead {
  readonly execution_status: TrialExecutionStatus;
  readonly oracle_result_ref: ArtifactRef;
  readonly preservation_verdict: PreservationVerdict;
  readonly correct_completion: boolean | null;
  readonly incompletion_reasons: readonly StructuredReason[];
}

/** A summary entry of a trial that could not start or could not be frozen (D-29). */
export interface UnevaluatedTrialResult extends TrialResultHead {
  readonly execution_status: 'incomplete' | 'not_started';
  readonly incompletion_reasons: readonly [StructuredReason, ...StructuredReason[]];
}

/** One trial-result entry of a run or validation summary (CTR-RUA-002). */
export type SummaryTrialResult = EvaluatedTrialResult | UnevaluatedTrialResult;
