// Canonical valid examples of the group A manifests and trial-state records, written from
// BR-RUA-019, BR-RUA-025, BR-RUA-036, BR-RUA-038, BR-RUA-040, BR-RUA-050, CA-1 and the reference
// values OR-RUA-001..005. Every duration is in milliseconds.

import type {
  DeclaredTiming,
  ExecutionManifest,
} from '../../../../../src/record-contract/records/group-a/execution_manifest.ts';
import type { ProviderTrialConfiguration } from '../../../../../src/record-contract/records/group-a/provider_trial_configuration.ts';
import type { ResourceManifest } from '../../../../../src/record-contract/records/group-a/resource_manifest.ts';
import type { TrialManifest } from '../../../../../src/record-contract/records/group-a/trial_manifest.ts';
import type { TrialRegistration } from '../../../../../src/record-contract/records/group-a/trial_registration.ts';
import {
  ACCOUNT_ID,
  COMMIT_SHA,
  COORDINATION_STACK_ID,
  COORDINATION_TABLE_ARN,
  DIGESTS,
  FIXTURE,
  IDS,
  TREE_SHA,
  instant,
  usd,
} from './sample-values.ts';

/** OR-RUA-002 in milliseconds. */
const OR_RUA_002_TIMING: DeclaredTiming = {
  provider_client_deadline_ms: 3000,
  provider_safety_release_ms: 15000,
  provider_execution_timeout_ms: 30000,
  conventional_invocation_timeout_ms: 10000,
  durable_invocation_timeout_ms: 10000,
  conventional_visibility_timeout_ms: 60000,
  durable_visibility_timeout_ms: 360000,
  durable_retry_delay_ms: 60000,
  durable_total_step_attempts: 2,
  durable_execution_timeout_ms: 300000,
  max_receive_count: 2,
  observation_deadline_ms: 600000,
  stabilization_interval_ms: 120000,
  queue_poll_interval_ms: 30000,
  treatment_poll_interval_ms: 250,
  retry_jitter: 'NONE',
};

/** The fields every execution kind shares; the plan (identity, trials, qualification) differs. */
function sharedManifestFields(): Omit<ExecutionManifest, 'execution_kind' | 'trials' | 'qualification'> {
  return {
    schema_version: 1,
    record_type: 'execution_manifest',
    admission_attempt_id: IDS.admissionAttempt,
    frozen_at: instant('12:00:05.000'),
    seed: 1,
    financial_inputs: {
      currency: FIXTURE.currency,
      payment_id: FIXTURE.payment_id,
      captured_amount_minor: FIXTURE.amount_minor,
      refund_request_id: FIXTURE.refund_request_id,
      approved_amount_minor: FIXTURE.amount_minor,
      decision: 'APPROVED',
    },
    timing: OR_RUA_002_TIMING,
    provider_warmup: { invocations_per_trial: 1 },
    safety: {
      region: 'us-east-1',
      active_ms: 4500000,
      cleanup_ms: 900000,
      total_ms: 5400000,
      ceiling_usd: usd('5.00'),
      concurrent_owners: 1,
    },
    environment: {
      environment_input_sha256: DIGESTS.environmentInput,
      account_id: ACCOUNT_ID,
      region: 'us-east-1',
      coordination_table_arn: COORDINATION_TABLE_ARN,
      coordination_stack_id: COORDINATION_STACK_ID,
      coordination_schema_version: 1,
    },
    source: {
      commit_sha: COMMIT_SHA,
      tree_sha: TREE_SHA,
      branch: 'feature/rua-study-1',
      clean_confirmed: true,
      lockfile_sha256: DIGESTS.lockfile,
      tool_versions: { node: 'v24.15.0', npm: '11.6.0' },
      source_provenance_sha256: DIGESTS.sourceProvenance,
    },
    schema_files: [
      { record_type: 'payment', relative_path: 'group-a/payment.schema.json', sha256: DIGESTS.schemaFile },
    ],
    transport_scope_snapshot_sha256: DIGESTS.scopeSnapshot,
    deployment_assembly: {
      assembly_path: 'admission/deployment-assembly',
      inventory_sha256: DIGESTS.inventory,
      template_path: 'admission/deployment-assembly/SucRua-run-00000000.template.json',
      template_sha256: DIGESTS.template,
    },
    estimates: { estimated_cost_usd: usd('1.25'), resource_counts: { functions: 4, tables: 5, queues: 4 } },
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
        conventional: 60000,
        durable: 360000,
        basis: 'BR-RUA-020: the Durable source stays invisible throughout its longer execution',
      },
    ],
  };
}

/** The canonical four-trial run in the BR-RUA-019 order. */
export function runExecutionManifest(): ExecutionManifest {
  return {
    ...sharedManifestFields(),
    execution_kind: 'RUN',
    run_id: IDS.run,
    trials: [
      { sequence: 1, trial_id: IDS.trial1, variant_id: 'conventional', scenario: 'CONTROL' },
      { sequence: 2, trial_id: IDS.trial2, variant_id: 'durable', scenario: 'CONTROL' },
      { sequence: 3, trial_id: IDS.trial3, variant_id: 'conventional', scenario: 'COMMIT_THEN_TIMEOUT' },
      { sequence: 4, trial_id: IDS.trial4, variant_id: 'durable', scenario: 'COMMIT_THEN_TIMEOUT' },
    ],
    qualification: {
      transport_probe_id: IDS.transportProbe,
      original_package_index_sha256: DIGESTS.packageIndex,
    },
  };
}

/** A Durable variant validation: control, then treatment (BR-RUA-038). */
export function validationExecutionManifest(): ExecutionManifest {
  return {
    ...sharedManifestFields(),
    execution_kind: 'VARIANT_VALIDATION',
    variant_validation_id: IDS.variantValidation,
    variant_id: 'durable',
    trials: [
      { sequence: 1, trial_id: IDS.trial1, variant_id: 'durable', scenario: 'CONTROL' },
      { sequence: 2, trial_id: IDS.trial2, variant_id: 'durable', scenario: 'COMMIT_THEN_TIMEOUT' },
    ],
    qualification: {
      transport_probe_id: IDS.transportProbe,
      original_package_index_sha256: DIGESTS.packageIndex,
      amendment_head_sha256: DIGESTS.amendmentHead,
    },
  };
}

/** A transport probe: no trials and no consumed qualification (OR-RUA-004 safety). */
export function probeExecutionManifest(): ExecutionManifest {
  return {
    ...sharedManifestFields(),
    execution_kind: 'TRANSPORT_PROBE',
    transport_probe_id: IDS.transportProbe,
    trials: [],
    qualification: null,
    safety: {
      region: 'us-east-1',
      active_ms: 600000,
      cleanup_ms: 600000,
      total_ms: 1200000,
      ceiling_usd: usd('1.00'),
      concurrent_owners: 1,
    },
  };
}

export function succeededResourceManifest(): ResourceManifest {
  return {
    schema_version: 1,
    record_type: 'resource_manifest',
    run_id: IDS.run,
    execution_manifest_sha256: DIGESTS.executionManifest,
    provisioning_status: 'succeeded',
    stack_name: 'SucRua-run-00000000',
    stack_id: `arn:aws:cloudformation:us-east-1:${ACCOUNT_ID}:stack/SucRua-run-00000000/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d`,
    resources: [
      {
        logical_id: 'ProviderVersion1A2B3C4D',
        resource_type: 'AWS::Lambda::Version',
        physical_id: `arn:aws:lambda:us-east-1:${ACCOUNT_ID}:function:suc1-00000000-provider:1`,
        resource_status: 'CREATE_COMPLETE',
      },
    ],
    ownership_tags: [
      { key: 'suc:project', value: 'serverless-under-constraints' },
      { key: 'suc:run_id', value: IDS.run },
    ],
    outputs: [{ key: 'ProviderQualifier', value: '1' }],
    provider_version: '1',
    configuration: [
      { logical_id: 'ControllerStreamMapping5E6F7A8B', attribute_path: 'BatchSize', canonical_json: '1' },
      {
        logical_id: 'ControllerStreamMapping5E6F7A8B',
        attribute_path: 'FilterCriteria',
        canonical_json: '{"Filters":[{"Pattern":"{\\"eventName\\":[\\"INSERT\\"]}"}]}',
      },
      { logical_id: 'ConventionalSourceQueue9A0B1C2D', attribute_path: 'VisibilityTimeout', canonical_json: '"60"' },
    ],
    deploy_started_at: instant('12:00:10.000'),
    deploy_completed_at: instant('12:03:10.000'),
    frozen_at: instant('12:03:11.000'),
  };
}

/** Provisioning failed before CloudFormation created the stack: nothing to name yet. */
export function failedResourceManifest(): ResourceManifest {
  return {
    schema_version: 1,
    record_type: 'resource_manifest',
    run_id: IDS.run,
    execution_manifest_sha256: DIGESTS.executionManifest,
    provisioning_status: 'failed',
    stack_name: 'SucRua-run-00000000',
    resources: [],
    ownership_tags: [{ key: 'suc:run_id', value: IDS.run }],
    outputs: [],
    deploy_started_at: instant('12:00:10.000'),
    frozen_at: instant('12:00:12.000'),
  };
}

export function trialManifest(): TrialManifest {
  return {
    schema_version: 1,
    record_type: 'trial_manifest',
    run_id: IDS.run,
    execution_manifest_sha256: DIGESTS.executionManifest,
    resource_manifest_sha256: DIGESTS.resourceManifest,
    trial_id: IDS.trial3,
    sequence: 3,
    variant_id: 'conventional',
    scenario: 'COMMIT_THEN_TIMEOUT',
    payment_sha256: DIGESTS.payment,
    approved_decision_sha256: DIGESTS.approvedDecision,
    frozen_at: instant('12:04:00.000'),
  };
}

export function trialProviderConfiguration(): ProviderTrialConfiguration {
  return {
    schema_version: 1,
    record_type: 'provider_trial_configuration',
    run_id: IDS.run,
    execution_manifest_sha256: DIGESTS.executionManifest,
    trial_id: IDS.trial3,
    trial_manifest_sha256: DIGESTS.trialManifest,
    scenario: 'COMMIT_THEN_TIMEOUT',
    registered_caller_id: 'conventional',
    payment_id: FIXTURE.payment_id,
    safety_release_ms: 15000,
    treatment_poll_interval_ms: 250,
    written_at: instant('12:04:01.000'),
  };
}

export function probeProviderConfiguration(): ProviderTrialConfiguration {
  return {
    schema_version: 1,
    record_type: 'provider_trial_configuration',
    transport_probe_id: IDS.transportProbe,
    execution_manifest_sha256: DIGESTS.executionManifest,
    scenario: 'COMMIT_THEN_TIMEOUT',
    registered_caller_id: 'probe',
    payment_id: FIXTURE.payment_id,
    safety_release_ms: 15000,
    treatment_poll_interval_ms: 250,
    written_at: instant('12:04:01.000'),
  };
}

export function trialRegistration(): TrialRegistration {
  return {
    schema_version: 1,
    record_type: 'trial_registration',
    variant_id: 'conventional',
    run_id: IDS.run,
    execution_manifest_sha256: DIGESTS.executionManifest,
    trial_id: IDS.trial3,
    trial_manifest_sha256: DIGESTS.trialManifest,
    registry_version: 3,
    registered_at: instant('12:04:02.000'),
  };
}
