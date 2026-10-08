// `execution_manifest` (BR-RUA-040): the canonical manifest of one run, variant validation or
// transport probe, frozen before the first mutation. Any change to a declared field requires a
// new execution identity.

import type { MoneyDecimal, Scenario, Sha256Hex, UtcMillis, Uuid4, VariantId } from '../../primitives.ts';
import type { ProviderWarmupPolicy } from './transport_scope_snapshot.ts';
import type { ToolVersions } from './source_provenance.ts';

/** BR-RUA-019: the canonical run's four sequential trials, in their only allowed order. */
export const RUN_TRIAL_ORDER = [
  { sequence: 1, variant_id: 'conventional', scenario: 'CONTROL' },
  { sequence: 2, variant_id: 'durable', scenario: 'CONTROL' },
  { sequence: 3, variant_id: 'conventional', scenario: 'COMMIT_THEN_TIMEOUT' },
  { sequence: 4, variant_id: 'durable', scenario: 'COMMIT_THEN_TIMEOUT' },
] as const satisfies readonly {
  readonly sequence: number;
  readonly variant_id: VariantId;
  readonly scenario: Scenario;
}[];

/** BR-RUA-038: a variant validation runs one variant's control, then its treatment. */
export const VALIDATION_SCENARIO_ORDER = ['CONTROL', 'COMMIT_THEN_TIMEOUT'] as const satisfies readonly Scenario[];

export interface DeclaredTrial {
  readonly sequence: number;
  readonly trial_id: Uuid4;
  readonly variant_id: VariantId;
  readonly scenario: Scenario;
}

/** OR-RUA-001 values declared once for every trial of the execution. */
export interface DeclaredFinancialInputs {
  readonly currency: 'BRL';
  readonly payment_id: string;
  readonly captured_amount_minor: number;
  readonly refund_request_id: string;
  readonly approved_amount_minor: number;
  readonly decision: 'APPROVED';
}

/** OR-RUA-002 timing and retry inputs, every duration in milliseconds. */
export interface DeclaredTiming {
  readonly provider_client_deadline_ms: number;
  readonly provider_safety_release_ms: number;
  readonly provider_execution_timeout_ms: number;
  readonly conventional_invocation_timeout_ms: number;
  readonly durable_invocation_timeout_ms: number;
  readonly conventional_visibility_timeout_ms: number;
  readonly durable_visibility_timeout_ms: number;
  readonly durable_retry_delay_ms: number;
  readonly durable_total_step_attempts: number;
  readonly durable_execution_timeout_ms: number;
  readonly max_receive_count: number;
  readonly observation_deadline_ms: number;
  readonly stabilization_interval_ms: number;
  readonly queue_poll_interval_ms: number;
  readonly treatment_poll_interval_ms: number;
  readonly retry_jitter: 'NONE';
}

/** OR-RUA-003, -004 or -005 safety inputs of the execution kind. */
export interface DeclaredSafety {
  readonly region: 'us-east-1';
  readonly active_ms: number;
  readonly cleanup_ms: number;
  readonly total_ms: number;
  readonly ceiling_usd: MoneyDecimal;
  readonly concurrent_owners: 1;
}

/** BR-RUA-041: the admitted, credential-free environment values frozen for execution. */
export interface AdmittedEnvironment {
  readonly environment_input_sha256: Sha256Hex;
  readonly account_id: string;
  readonly region: 'us-east-1';
  readonly coordination_table_arn: string;
  readonly coordination_stack_id: string;
  readonly coordination_schema_version: number;
}

/** BR-RUA-042: commit, tree, branch when attached, clean confirmation, lockfile and tools. */
export interface DeclaredSource {
  readonly commit_sha: string;
  readonly tree_sha: string;
  readonly branch?: string;
  readonly clean_confirmed: true;
  readonly lockfile_sha256: Sha256Hex;
  readonly tool_versions: ToolVersions;
  readonly source_provenance_sha256: Sha256Hex;
}

export interface SchemaFileDigest {
  readonly record_type: string;
  readonly relative_path: string;
  readonly sha256: Sha256Hex;
}

/** BR-RUA-028: the explicitly selected probe a run or variant validation consumes. */
export interface SelectedQualification {
  readonly transport_probe_id: Uuid4;
  readonly original_package_index_sha256: Sha256Hex;
  /** Present only when an amendment head is explicitly selected. */
  readonly amendment_head_sha256?: Sha256Hex;
}

export interface FrozenDeploymentAssembly {
  readonly assembly_path: string;
  /** The `inventory_sha256` of the deployment-assembly inventory. */
  readonly inventory_sha256: Sha256Hex;
  readonly template_path: string;
  readonly template_sha256: Sha256Hex;
}

export interface ConservativeEstimates {
  readonly estimated_cost_usd: MoneyDecimal;
  /** Resource kind (snake_case) to its planned count. */
  readonly resource_counts: Readonly<Record<string, number>>;
}

/** The CA-1 scope, verbatim from the spec. */
export const CA_1_SCOPE = 'same-account, same-Region AWS Lambda execution environments';

/** The CA-1 statement, verbatim from the spec (its line break joined by one space). */
export const CA_1_STATEMENT =
  'UTC wall-clock timestamps preserve the ordering of the provider commit and caller timer events for this PoC.';

/** CA-1, the PoC clock-alignment assumption, declared verbatim as a study assumption. */
export interface ClockAssumptionDeclaration {
  readonly assumption_id: 'CA-1';
  readonly assumption_type: 'clock_alignment';
  readonly scope: typeof CA_1_SCOPE;
  readonly statement: typeof CA_1_STATEMENT;
  readonly status: 'declared_not_service_guaranteed';
}

/** One variant's side of a declared difference; never null, because both sides name a value. */
export type DeclaredVariantValue = string | number | boolean;

/** BR-RUA-007: a difference that is part of the variants' declared execution strategies. */
export interface DeclaredVariantDifference {
  readonly parameter: string;
  readonly conventional: DeclaredVariantValue;
  readonly durable: DeclaredVariantValue;
  readonly basis: string;
}

/** The identity, trial plan and qualification that differ per execution kind. */
export type ExecutionPlan =
  | {
      readonly execution_kind: 'RUN';
      readonly run_id: Uuid4;
      readonly trials: readonly [DeclaredTrial, DeclaredTrial, DeclaredTrial, DeclaredTrial];
      readonly qualification: SelectedQualification;
    }
  | {
      readonly execution_kind: 'VARIANT_VALIDATION';
      readonly variant_validation_id: Uuid4;
      readonly variant_id: VariantId;
      readonly trials: readonly [DeclaredTrial, DeclaredTrial];
      readonly qualification: SelectedQualification;
    }
  | {
      readonly execution_kind: 'TRANSPORT_PROBE';
      readonly transport_probe_id: Uuid4;
      readonly trials: readonly [];
      /** A probe creates the qualification it is judged on, so it consumes none. */
      readonly qualification: null;
    };

export type ExecutionManifest = ExecutionPlan & {
  readonly schema_version: 1;
  readonly record_type: 'execution_manifest';
  readonly admission_attempt_id: Uuid4;
  readonly frozen_at: UtcMillis;
  /** BR-RUA-019: recorded for future deterministic scheduling; it does not derive the order. */
  readonly seed: 1;
  readonly financial_inputs: DeclaredFinancialInputs;
  readonly timing: DeclaredTiming;
  readonly provider_warmup: ProviderWarmupPolicy;
  readonly safety: DeclaredSafety;
  readonly environment: AdmittedEnvironment;
  readonly source: DeclaredSource;
  readonly schema_files: readonly [SchemaFileDigest, ...SchemaFileDigest[]];
  readonly transport_scope_snapshot_sha256: Sha256Hex;
  readonly deployment_assembly: FrozenDeploymentAssembly;
  readonly estimates: ConservativeEstimates;
  readonly clock_assumptions: readonly [ClockAssumptionDeclaration];
  readonly declared_variant_differences: readonly DeclaredVariantDifference[];
};
