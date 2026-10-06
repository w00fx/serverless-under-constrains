// The execution-level primary files of a golden base: the execution manifest frozen at admission
// (BR-RUA-040) and the resource manifest frozen after provisioning (BR-RUA-050). Values come from
// the spec's reference tables: OR-RUA-001 financial inputs, OR-RUA-002 timing, and the safety
// inputs of the execution kind (OR-RUA-003 run, OR-RUA-004 probe, OR-RUA-005 validation). Files
// the fixture does not carry (environment input, source provenance, scope snapshot, deployment
// assembly) are named by label digests.

import type { ExecutionIdentityFields } from '../../../src/record-contract/envelope.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import { linkSha256 } from './digest-links.ts';
import type { GoldenExecution } from './golden-plan.ts';
import { declaredTrialsOf } from './golden-plan.ts';
import {
  FINANCIAL_FIXTURE,
  GOLDEN_ACCOUNT_ID,
  GOLDEN_PROVIDER_VERSION,
  GOLDEN_REGION,
  goldenUuid,
  instantAt,
  labelDigest,
  usd,
} from './golden-values.ts';
import { EXECUTION_MANIFEST_PATH } from './trial-context.ts';
import type { ExecutionContext } from './trial-context.ts';

/** Execution-level instants, in milliseconds after the timeline origin. */
export const EXECUTION_OFFSETS = {
  manifest_frozen: 0,
  lease_acquired: 1000,
  deploy_started: 10_000,
  deploy_completed: 190_000,
  resource_manifest_frozen: 195_000,
  provisioning_succeeded: 200_000,
  readiness_succeeded: 250_000,
  trials_started: 290_000,
} as const;

const COORDINATION_STACK_ID = `arn:aws:cloudformation:${GOLDEN_REGION}:${GOLDEN_ACCOUNT_ID}:stack/suc-study-1-coordination/${goldenUuid('coordination/stack')}`;

/**
 * The identity of a golden execution: label-derived ids, so every base of one execution shares
 * them.
 *
 * @example
 * executionContextOf('run').identity; // { run_id }
 */
export function executionContextOf(execution: GoldenExecution): ExecutionContext {
  const executionId = goldenUuid(`${execution}/execution_id`);
  return {
    label: execution,
    execution_id: executionId,
    identity: identityFieldsOf(execution, executionId),
    resource_prefix: executionId.slice(0, 8),
  };
}

function identityFieldsOf(
  execution: GoldenExecution,
  executionId: ReturnType<typeof goldenUuid>,
): ExecutionIdentityFields {
  switch (execution) {
    case 'run':
      return { run_id: executionId };
    case 'probe':
      return { transport_probe_id: executionId };
    case 'validation-conventional':
    case 'validation-durable':
      return { variant_validation_id: executionId };
  }
}

/**
 * The trial id of the declared trial at `sequence`.
 *
 * @example
 * trialIdOf('run', 3); // the conventional COMMIT_THEN_TIMEOUT trial of the run
 */
export function trialIdOf(execution: GoldenExecution, sequence: number): ReturnType<typeof goldenUuid> {
  return goldenUuid(`${execution}/trial-${String(sequence)}/trial_id`);
}

/**
 * The frozen execution manifest of a golden execution.
 *
 * @example
 * executionManifest('validation-durable')['variant_id']; // 'durable'
 */
export function executionManifest(execution: GoldenExecution): JsonObject {
  const context = executionContextOf(execution);
  return {
    schema_version: 1,
    record_type: 'execution_manifest',
    ...planFields(execution, context),
    admission_attempt_id: goldenUuid(`${execution}/admission_attempt_id`),
    frozen_at: instantAt(EXECUTION_OFFSETS.manifest_frozen),
    seed: 1,
    financial_inputs: { ...FINANCIAL_FIXTURE },
    timing: {
      provider_client_deadline_ms: 3000,
      provider_safety_release_ms: 15_000,
      provider_execution_timeout_ms: 30_000,
      conventional_invocation_timeout_ms: 10_000,
      durable_invocation_timeout_ms: 10_000,
      conventional_visibility_timeout_ms: 60_000,
      durable_visibility_timeout_ms: 360_000,
      durable_retry_delay_ms: 60_000,
      durable_total_step_attempts: 2,
      durable_execution_timeout_ms: 300_000,
      max_receive_count: 2,
      observation_deadline_ms: 600_000,
      stabilization_interval_ms: 120_000,
      queue_poll_interval_ms: 30_000,
      treatment_poll_interval_ms: 250,
      retry_jitter: 'NONE',
    },
    provider_warmup: { invocations_per_trial: 1 },
    safety: safetyOf(execution),
    environment: {
      environment_input_sha256: labelDigest(`${execution}/environment-input`),
      account_id: GOLDEN_ACCOUNT_ID,
      region: GOLDEN_REGION,
      coordination_table_arn: `arn:aws:dynamodb:${GOLDEN_REGION}:${GOLDEN_ACCOUNT_ID}:table/suc-study-1-coordination`,
      coordination_stack_id: COORDINATION_STACK_ID,
      coordination_schema_version: 1,
    },
    source: {
      commit_sha: labelDigest('source/commit').slice(0, 40),
      tree_sha: labelDigest('source/tree').slice(0, 40),
      branch: 'feature/rua-study-1',
      clean_confirmed: true,
      lockfile_sha256: labelDigest('source/lockfile'),
      tool_versions: { node: 'v24.15.0', npm: '11.6.0' },
      source_provenance_sha256: labelDigest(`${execution}/source-provenance`),
    },
    schema_files: [
      { record_type: 'payment', relative_path: 'group-a/payment.schema.json', sha256: labelDigest('schema/payment') },
    ],
    transport_scope_snapshot_sha256: labelDigest('transport-scope-snapshot'),
    deployment_assembly: {
      assembly_path: 'admission/deployment-assembly',
      inventory_sha256: labelDigest(`${execution}/deployment-assembly-inventory`),
      template_path: `admission/deployment-assembly/${stackNameOf(execution, context)}.template.json`,
      template_sha256: labelDigest(`${execution}/template`),
    },
    estimates: { estimated_cost_usd: usd('1.25'), resource_counts: { functions: 4, queues: 4, tables: 5 } },
    clock_assumptions: [
      {
        assumption_id: 'CA-1',
        assumption_type: 'clock_alignment',
        scope: 'same-account, same-Region AWS Lambda execution environments',
        statement:
          'UTC wall-clock timestamps preserve the ordering of the provider commit and caller timer events for this PoC.',
        status: 'declared_not_service_guaranteed',
      },
    ],
    declared_variant_differences: [
      {
        parameter: 'source_visibility_timeout_ms',
        conventional: 60_000,
        durable: 360_000,
        basis: 'BR-RUA-020: the Durable source stays invisible throughout its longer execution',
      },
    ],
  };
}

/** OR-RUA-003 and OR-RUA-005 (identical maximums). */
const RUN_SAFETY: JsonObject = {
  region: GOLDEN_REGION,
  active_ms: 4_500_000,
  cleanup_ms: 900_000,
  total_ms: 5_400_000,
  ceiling_usd: usd('5.00'),
  concurrent_owners: 1,
};

/** OR-RUA-004. */
const PROBE_SAFETY: JsonObject = {
  region: GOLDEN_REGION,
  active_ms: 600_000,
  cleanup_ms: 600_000,
  total_ms: 1_200_000,
  ceiling_usd: usd('1.00'),
  concurrent_owners: 1,
};

function safetyOf(execution: GoldenExecution): JsonObject {
  return execution === 'probe' ? PROBE_SAFETY : RUN_SAFETY;
}

function planFields(execution: GoldenExecution, context: ExecutionContext): JsonObject {
  const trials = declaredTrialsOf(execution).map((trial) => ({
    sequence: trial.sequence,
    trial_id: trialIdOf(execution, trial.sequence),
    variant_id: trial.variant_id,
    scenario: trial.scenario,
  }));
  const qualification = {
    transport_probe_id: executionContextOf('probe').execution_id,
    original_package_index_sha256: labelDigest('probe/package-index'),
  };
  switch (execution) {
    case 'run':
      return { execution_kind: 'RUN', ...context.identity, trials, qualification };
    case 'probe':
      return { execution_kind: 'TRANSPORT_PROBE', ...context.identity, trials, qualification: null };
    case 'validation-conventional':
    case 'validation-durable':
      return {
        execution_kind: 'VARIANT_VALIDATION',
        ...context.identity,
        variant_id: execution === 'validation-conventional' ? 'conventional' : 'durable',
        trials,
        qualification,
      };
  }
}

function stackNameOf(execution: GoldenExecution, context: ExecutionContext): string {
  const kind = execution === 'run' || execution === 'probe' ? execution : 'validation';
  return `SucRua-${kind}-${context.resource_prefix}`;
}

/**
 * The resource manifest of a successful deploy: stack, provider version, BR-RUA-050 ownership
 * tags (a validation stack adds `suc:variant_id`) and the post-deploy configuration snapshot.
 *
 * @example
 * resourceManifest('run')['provider_version']; // '1'
 */
export function resourceManifest(execution: GoldenExecution): JsonObject {
  const context = executionContextOf(execution);
  const stackName = stackNameOf(execution, context);
  const prefix = context.resource_prefix;
  const variantTag =
    execution === 'validation-conventional' || execution === 'validation-durable'
      ? [{ key: 'suc:variant_id', value: execution === 'validation-conventional' ? 'conventional' : 'durable' }]
      : [];
  return {
    schema_version: 1,
    record_type: 'resource_manifest',
    ...context.identity,
    execution_manifest_sha256: linkSha256(EXECUTION_MANIFEST_PATH),
    provisioning_status: 'succeeded',
    stack_name: stackName,
    stack_id: `arn:aws:cloudformation:${GOLDEN_REGION}:${GOLDEN_ACCOUNT_ID}:stack/${stackName}/${goldenUuid(`${execution}/stack`)}`,
    resources: [
      {
        logical_id: 'ProviderVersion',
        resource_type: 'AWS::Lambda::Version',
        physical_id: `arn:aws:lambda:${GOLDEN_REGION}:${GOLDEN_ACCOUNT_ID}:function:suc1-${prefix}-refund-provider:${GOLDEN_PROVIDER_VERSION}`,
        resource_status: 'CREATE_COMPLETE',
      },
    ],
    ownership_tags: [
      { key: 'suc:project', value: 'serverless-under-constraints' },
      { key: 'suc:study_id', value: 'study-1' },
      { key: 'suc:run_id', value: context.execution_id },
      { key: 'suc:managed_by', value: 'rua-operator-cli' },
      {
        key: 'suc:expires_at',
        value: instantAt(EXECUTION_OFFSETS.manifest_frozen + Number(safetyOf(execution)['total_ms'])),
      },
      ...variantTag,
    ],
    outputs: [{ key: 'ProviderQualifier', value: GOLDEN_PROVIDER_VERSION }],
    provider_version: GOLDEN_PROVIDER_VERSION,
    configuration: [
      { logical_id: 'ProviderVersion', attribute_path: 'Version', canonical_json: `"${GOLDEN_PROVIDER_VERSION}"` },
    ],
    deploy_started_at: instantAt(EXECUTION_OFFSETS.deploy_started),
    deploy_completed_at: instantAt(EXECUTION_OFFSETS.deploy_completed),
    frozen_at: instantAt(EXECUTION_OFFSETS.resource_manifest_frozen),
  };
}
