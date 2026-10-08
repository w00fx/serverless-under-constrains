// The canonical execution manifest (BR-RUA-040, BR-RUA-019, OR-RUA-001..005, CA-1, BR-RUA-007;
// design §10.1 A15). It is assembled only from values admission has checked and digests of the
// files the package draft holds, so a changed declared field always means a new execution
// identity. The timing, the warm-up policy, the clock assumption and the declared variant
// differences are the committed declarations, never request input.

import type { Sha256Hex, UtcMillis, Uuid4 } from '../record-contract/primitives.ts';
import type {
  AdmittedEnvironment,
  ConservativeEstimates,
  DeclaredFinancialInputs,
  DeclaredSafety,
  DeclaredSource,
  ExecutionManifest,
  FrozenDeploymentAssembly,
  SchemaFileDigest,
} from '../record-contract/records/group-a/execution_manifest.ts';
import {
  CA_1_DECLARATION,
  OR_RUA_002_TIMING,
  PROVIDER_WARMUP_POLICY,
  declaredVariantDifferences,
} from './declared-inputs.ts';
import type { DeclaredExecution } from './execution-identities.ts';

export interface ManifestInput {
  readonly admission_attempt_id: Uuid4;
  readonly frozen_at: UtcMillis;
  readonly execution: DeclaredExecution;
  readonly financial_inputs: DeclaredFinancialInputs;
  readonly safety: DeclaredSafety;
  readonly environment: AdmittedEnvironment;
  readonly source: DeclaredSource;
  readonly schema_files: readonly [SchemaFileDigest, ...SchemaFileDigest[]];
  readonly transport_scope_snapshot_sha256: Sha256Hex;
  readonly deployment_assembly: FrozenDeploymentAssembly;
  readonly estimates: ConservativeEstimates;
}

/**
 * Builds the manifest an admitted execution freezes.
 *
 * @example
 * buildExecutionManifest(input).seed; // 1
 */
export function buildExecutionManifest(input: ManifestInput): ExecutionManifest {
  return {
    ...input.execution.plan,
    schema_version: 1,
    record_type: 'execution_manifest',
    admission_attempt_id: input.admission_attempt_id,
    frozen_at: input.frozen_at,
    seed: 1,
    financial_inputs: input.financial_inputs,
    timing: OR_RUA_002_TIMING,
    provider_warmup: PROVIDER_WARMUP_POLICY,
    safety: input.safety,
    environment: input.environment,
    source: input.source,
    schema_files: input.schema_files,
    transport_scope_snapshot_sha256: input.transport_scope_snapshot_sha256,
    deployment_assembly: input.deployment_assembly,
    estimates: input.estimates,
    clock_assumptions: [CA_1_DECLARATION],
    declared_variant_differences: declaredVariantDifferences(input.execution.plan.execution_kind),
  };
}
