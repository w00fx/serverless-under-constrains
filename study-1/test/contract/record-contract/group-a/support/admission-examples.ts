// Canonical valid examples of the group A admission and qualification-scope records, written
// from BR-RUA-028, BR-RUA-039, BR-RUA-042, BR-RUA-046, the design's admission steps (§10.1),
// the frozen-assembly procedure (§9.8) and the warm-up policy (addendum §2).

import type { AdmissionRejection } from '../../../../../src/record-contract/records/group-a/admission_rejection.ts';
import type { DeploymentAssemblyInventory } from '../../../../../src/record-contract/records/group-a/deployment_assembly_inventory.ts';
import type { PreflightCheckRecorded } from '../../../../../src/record-contract/records/group-a/preflight_check_recorded.ts';
import type { SourceProvenance } from '../../../../../src/record-contract/records/group-a/source_provenance.ts';
import type { TransportScopePolicy } from '../../../../../src/record-contract/records/group-a/transport_scope_policy.ts';
import type { TransportScopeSnapshot } from '../../../../../src/record-contract/records/group-a/transport_scope_snapshot.ts';
import {
  COMMIT_SHA,
  CONTROLLER_FILTER_CRITERIA_JSON,
  DIGESTS,
  IDS,
  TREE_SHA,
  digest,
  instant,
} from './sample-values.ts';

/**
 * A financial-input rejection: the approved amount differs from the captured amount (D-31).
 *
 * @example
 * admissionRejection().rejection_class; // 'FINANCIAL_INPUT'
 */
export function admissionRejection(): AdmissionRejection {
  return {
    schema_version: 1,
    record_type: 'admission_rejection',
    admission_attempt_id: IDS.admissionAttempt,
    execution_kind: 'RUN',
    rejection_class: 'FINANCIAL_INPUT',
    failed_check_id: 'A3',
    reasons: [
      {
        code: 'AMOUNT_MISMATCH',
        subject: 'approved_amount_minor',
        detail: 'approved_amount_minor is 5000; expected it to equal captured_amount_minor 10000',
      },
    ],
    rejected_at: instant('12:00:01.250'),
  };
}

/**
 * A passed safety step: the estimated attributable cost is within the OR-RUA-003 ceiling.
 *
 * @example
 * passedPreflightCheck().result; // 'passed'
 */
export function passedPreflightCheck(): PreflightCheckRecorded {
  return {
    schema_version: 1,
    record_type: 'preflight_check_recorded',
    admission_attempt_id: IDS.admissionAttempt,
    sequence: 14,
    check_id: 'A14',
    subject: 'estimated_attributable_cost',
    expected: { ceiling_usd: '5.00' },
    observed: { estimated_cost_usd: '1.25' },
    result: 'passed',
    reasons: [],
    evidence_refs: [],
    checked_at: instant('12:00:04.000'),
  };
}

/**
 * The failed step behind `admissionRejection()`, with the evidence it judged.
 *
 * @example
 * failedPreflightCheck().check_id; // 'A3'
 */
export function failedPreflightCheck(): PreflightCheckRecorded {
  return {
    schema_version: 1,
    record_type: 'preflight_check_recorded',
    admission_attempt_id: IDS.admissionAttempt,
    sequence: 3,
    check_id: 'A3',
    subject: 'financial_input',
    expected: { approved_amount_minor: 10000 },
    observed: { approved_amount_minor: 5000 },
    result: 'failed',
    rejection_class: 'FINANCIAL_INPUT',
    reasons: [
      {
        code: 'AMOUNT_MISMATCH',
        subject: 'approved_amount_minor',
        detail: 'approved_amount_minor is 5000; expected it to equal captured_amount_minor 10000',
      },
    ],
    evidence_refs: [{ artifact_path: 'inputs/approved-decision.json', artifact_sha256: DIGESTS.approvedDecision }],
    checked_at: instant('12:00:01.200'),
  };
}

/**
 * A clean checkout of an attached branch (BR-RUA-042).
 *
 * @example
 * sourceProvenance().branch; // 'feature/rua-study-1'
 */
export function sourceProvenance(): SourceProvenance {
  return {
    schema_version: 1,
    record_type: 'source_provenance',
    admission_attempt_id: IDS.admissionAttempt,
    commit_sha: COMMIT_SHA,
    tree_sha: TREE_SHA,
    detached_head: false,
    branch: 'feature/rua-study-1',
    clean_confirmed: true,
    lockfile_path: 'package-lock.json',
    lockfile_sha256: DIGESTS.lockfile,
    tool_versions: { node: 'v24.15.0', npm: '11.6.0', esbuild: '0.28.2', aws_cdk_cli: '2.1144.0' },
    recorded_at: instant('12:00:02.000'),
  };
}

/**
 * A frozen assembly of three regular files, sorted by path (BR-RUA-042).
 *
 * @example
 * deploymentAssemblyInventory().files.length; // 3
 */
export function deploymentAssemblyInventory(): DeploymentAssemblyInventory {
  return {
    schema_version: 1,
    record_type: 'deployment_assembly_inventory',
    assembly_path: 'admission/deployment-assembly',
    files: [
      { path: 'SucRua-run-00000000.template.json', bytes: 48211, mode: '0644', sha256: DIGESTS.template },
      { path: 'asset.0a1b2c3d/index.mjs', bytes: 912345, mode: '0644', sha256: digest('0') },
      { path: 'manifest.json', bytes: 2048, mode: '0644', sha256: digest('a') },
    ],
    inventory_sha256: DIGESTS.inventory,
    inventoried_at: instant('12:00:03.000'),
  };
}

/**
 * A committed scope policy over the provider, controller and probe caller (BR-RUA-028).
 *
 * @example
 * transportScopePolicy().configuration_projections[0].projection_id; // 'provider_function'
 */
export function transportScopePolicy(): TransportScopePolicy {
  return {
    schema_version: 1,
    record_type: 'transport_scope_policy',
    entry_points: [
      'src/refund-provider/refund-provider.handler.ts',
      'src/treatment-controller/treatment-controller.handler.ts',
      'src/transport-probe-caller/transport-probe-caller.handler.ts',
    ],
    source_roots: ['src/provider-client', 'src/refund-provider', 'src/treatment-controller', 'src/record-contract'],
    configuration_projections: [
      {
        projection_id: 'provider_function',
        resource_type: 'AWS::Lambda::Function',
        property_paths: ['Properties.Timeout', 'Properties.MemorySize', 'Properties.Runtime'],
      },
      {
        projection_id: 'controller_event_source_mapping',
        resource_type: 'AWS::Lambda::EventSourceMapping',
        property_paths: ['Properties.BatchSize', 'Properties.StartingPosition', 'Properties.FilterCriteria'],
      },
    ],
    runtime_properties: ['node_runtime', 'architecture', 'memory_size_mb'],
    dependencies: ['@aws-sdk/client-lambda', '@aws-sdk/client-dynamodb', '@smithy/node-http-handler'],
  };
}

/**
 * A frozen scope snapshot with the controller mapping and provider function projections (BR-RUA-028).
 *
 * @example
 * transportScopeSnapshot().provider_warmup; // { invocations_per_trial: 1 }
 */
export function transportScopeSnapshot(): TransportScopeSnapshot {
  return {
    schema_version: 1,
    record_type: 'transport_scope_snapshot',
    policy_sha256: DIGESTS.policy,
    entry_points: ['src/refund-provider/refund-provider.handler.ts'],
    source_files: [
      { path: 'src/provider-client/provider-client.ts', sha256: digest('b') },
      { path: 'src/refund-provider/refund-provider.handler.ts', sha256: digest('c') },
    ],
    dependency_closure: [
      { name: '@aws-sdk/client-lambda', version: '3.1146.0' },
      { name: '@smithy/node-http-handler', version: '4.12.1' },
    ],
    lockfile_sha256: DIGESTS.lockfile,
    configuration_projections: [
      {
        projection_id: 'controller_event_source_mapping',
        resources: [
          {
            property_values: [
              { property_path: 'Properties.BatchSize', canonical_json: '1' },
              { property_path: 'Properties.StartingPosition', canonical_json: '"TRIM_HORIZON"' },
              { property_path: 'Properties.FilterCriteria', canonical_json: CONTROLLER_FILTER_CRITERIA_JSON },
            ],
          },
        ],
      },
      {
        projection_id: 'provider_function',
        resources: [
          {
            property_values: [
              { property_path: 'Properties.Timeout', canonical_json: '30' },
              { property_path: 'Properties.MemorySize', canonical_json: '512' },
              { property_path: 'Properties.Runtime', canonical_json: '"nodejs24.x"' },
            ],
          },
        ],
      },
    ],
    runtime_properties: { node_runtime: 'nodejs24.x', architecture: 'x86_64', memory_size_mb: 512 },
    timing_values: {
      provider_client_deadline_ms: 3000,
      provider_safety_release_ms: 15000,
      provider_execution_timeout_ms: 30000,
      treatment_poll_interval_ms: 250,
    },
    provider_warmup: { invocations_per_trial: 1 },
  };
}
