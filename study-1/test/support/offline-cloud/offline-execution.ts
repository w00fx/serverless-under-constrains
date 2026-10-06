// The execution an offline cloud runs: the golden builder's run or conventional variant
// validation (design §12.4 identities and reference values), admitted and provisioned. Its core
// files are what admission and provisioning freeze before any trial (design §7): the execution
// manifest and resource manifest the golden bases carry, plus the environment input, source
// provenance, oracle revision check and deployment-assembly inventory every evidence index
// covers, taken from the record contract's canonical examples. The execution manifest is pointed
// at the exact bytes of those four files, so every digest a trial pins names a file on disk.

import { PACKAGE_LAYOUT, EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonObject, JsonValue, Sha256Hex } from '../../../src/record-contract/primitives.ts';
import type { StudyRecord } from '../../../src/record-contract/records/index.ts';
import type { DeclaredTrial, TrialExecution, TrialPlan } from '../../../src/trial-execution/trial-execution-ports.ts';
import { CANONICAL_EXAMPLES as GROUP_A_EXAMPLES } from '../../contract/record-contract/group-a/support/canonical-examples.ts';
import { CANONICAL_EXAMPLES as GROUP_C_EXAMPLES } from '../../contract/record-contract/group-c/examples/group-c-examples.ts';
import { serializeScenarioFiles } from '../golden-builder/digest-links.ts';
import {
  executionContextOf,
  executionManifest,
  resourceManifest,
  trialIdOf,
} from '../golden-builder/execution-files.ts';
import { declaredTrialsOf } from '../golden-builder/golden-plan.ts';
import {
  FINANCIAL_FIXTURE,
  GOLDEN_ACCOUNT_ID,
  GOLDEN_CALLER_VERSION,
  GOLDEN_PROVIDER_VERSION,
  GOLDEN_REGION,
  GOLDEN_TIMING,
} from '../golden-builder/golden-values.ts';
import { EXECUTION_MANIFEST_PATH, RESOURCE_MANIFEST_PATH, queueName } from '../golden-builder/trial-context.ts';
import type { ExecutionContext } from '../golden-builder/trial-context.ts';

/** The executions with trials that the offline cloud can run. */
export type OfflineExecutionName = 'run' | 'validation-conventional';

/** One admitted, provisioned execution and its frozen core files. */
export interface OfflineExecution {
  readonly name: OfflineExecutionName;
  readonly context: ExecutionContext;
  readonly identity: TrialExecution;
  /** `runs/<run_id>` or `variant-validations/<id>`. */
  readonly package_directory: string;
  /** Package-relative path to exact bytes. */
  readonly core_files: ReadonlyMap<string, Uint8Array>;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly resource_manifest_sha256: Sha256Hex;
  readonly declared: readonly DeclaredTrial[];
}

/**
 * Builds the offline execution and its core files.
 *
 * @example
 * offlineExecution('run').declared.map((trial) => trial.variant_id); // conventional, durable, conventional, durable
 */
export function offlineExecution(name: OfflineExecutionName): OfflineExecution {
  const context = executionContextOf(name);
  const identity: TrialExecution =
    name === 'run'
      ? { execution_kind: 'RUN', run_id: context.execution_id }
      : { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: context.execution_id };
  const admission = new Map<string, Uint8Array>([
    [EXECUTION_PATHS.environmentInput, recordBytes(GROUP_A_EXAMPLES.environment_input())],
    [EXECUTION_PATHS.sourceProvenance, recordBytes(GROUP_A_EXAMPLES.source_provenance())],
    [EXECUTION_PATHS.oracleRevisionCheck, serializeRecordFile(GROUP_C_EXAMPLES.oracle_revision_check())],
    [EXECUTION_PATHS.deploymentAssemblyInventory, recordBytes(GROUP_A_EXAMPLES.deployment_assembly_inventory())],
  ]);
  const manifests = serializeScenarioFiles(
    new Map([
      [EXECUTION_MANIFEST_PATH, { kind: 'json', record: pinnedManifest(name, admission) }],
      [RESOURCE_MANIFEST_PATH, { kind: 'json', record: resourceManifest(name) }],
    ]),
  );
  if (!manifests.ok) {
    throw new Error(
      `offline ${name} manifests do not serialize: ${manifests.error.join('; ')}; expected golden manifests`,
    );
  }
  const coreFiles = new Map([...admission, ...manifests.value]);
  return {
    name,
    context,
    identity,
    package_directory: PACKAGE_LAYOUT.executionDirectory(identity),
    core_files: coreFiles,
    execution_manifest_sha256: digestOf(coreFiles, EXECUTION_MANIFEST_PATH),
    resource_manifest_sha256: digestOf(coreFiles, RESOURCE_MANIFEST_PATH),
    declared: declaredTrialsOf(name).map((trial) => ({ ...trial, trial_id: trialIdOf(name, trial.sequence) })),
  };
}

/**
 * The plan of the declared trial at `sequence` (1-based).
 *
 * @example
 * offlineTrialPlan(offlineExecution('run'), 1).trial.scenario; // 'CONTROL'
 */
export function offlineTrialPlan(execution: OfflineExecution, sequence: number): TrialPlan {
  const trial = execution.declared[sequence - 1];
  if (trial === undefined) {
    throw new RangeError(
      `${execution.name} has no declared trial ${String(sequence)}; expected 1 to ${String(execution.declared.length)}`,
    );
  }
  const prefix = execution.context.resource_prefix;
  return {
    execution: execution.identity,
    execution_manifest_sha256: execution.execution_manifest_sha256,
    resource_manifest_sha256: execution.resource_manifest_sha256,
    trial,
    payment: {
      schema_version: 1,
      record_type: 'payment',
      payment_id: FINANCIAL_FIXTURE.payment_id,
      captured_amount_minor: FINANCIAL_FIXTURE.captured_amount_minor,
      currency: FINANCIAL_FIXTURE.currency,
    },
    approved_decision: {
      schema_version: 1,
      record_type: 'approved_decision',
      refund_request_id: FINANCIAL_FIXTURE.refund_request_id,
      payment_id: FINANCIAL_FIXTURE.payment_id,
      decision: FINANCIAL_FIXTURE.decision,
      approved_amount_minor: FINANCIAL_FIXTURE.approved_amount_minor,
      currency: FINANCIAL_FIXTURE.currency,
    },
    provider_timing: {
      safety_release_ms: GOLDEN_TIMING.provider_safety_release_ms,
      treatment_poll_interval_ms: GOLDEN_TIMING.treatment_poll_interval_ms,
    },
    provider_version: GOLDEN_PROVIDER_VERSION,
    queues: {
      source: queueTarget(execution.context, trial.variant_id, 'source'),
      dlq: queueTarget(execution.context, trial.variant_id, 'dlq'),
    },
    ...(trial.variant_id === 'durable'
      ? {
          durable_caller: {
            function_arn: `arn:aws:lambda:${GOLDEN_REGION}:${GOLDEN_ACCOUNT_ID}:function:suc1-${prefix}-durable-caller`,
            qualifier: GOLDEN_CALLER_VERSION,
          },
        }
      : {}),
  };
}

/**
 * The URL and name of a variant queue (design §9.7 naming).
 *
 * @example
 * queueTarget(context, 'conventional', 'dlq').queue_name; // 'suc1-<p>-conventional-dlq.fifo'
 */
export function queueTarget(
  context: ExecutionContext,
  variant: string,
  role: 'source' | 'dlq',
): { readonly queue_url: string; readonly queue_name: string } {
  const name = queueName(context, variant, role);
  return { queue_url: `https://sqs.${GOLDEN_REGION}.amazonaws.com/${GOLDEN_ACCOUNT_ID}/${name}`, queue_name: name };
}

// The golden manifest names label digests for files a golden base does not carry; the offline
// execution carries them, so the manifest names their exact bytes instead.
function pinnedManifest(name: OfflineExecutionName, admission: ReadonlyMap<string, Uint8Array>): JsonObject {
  const manifest = executionManifest(name);
  const digest = (path: string): Sha256Hex => digestOf(admission, path);
  return {
    ...manifest,
    environment: {
      ...objectAt(manifest, 'environment'),
      environment_input_sha256: digest(EXECUTION_PATHS.environmentInput),
    },
    source: { ...objectAt(manifest, 'source'), source_provenance_sha256: digest(EXECUTION_PATHS.sourceProvenance) },
    deployment_assembly: {
      ...objectAt(manifest, 'deployment_assembly'),
      inventory_sha256: digest(EXECUTION_PATHS.deploymentAssemblyInventory),
    },
  };
}

function objectAt(record: JsonObject, field: string): JsonObject {
  const value: JsonValue | undefined = record[field];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`execution manifest ${field} is ${JSON.stringify(value)}; expected an object`);
  }
  return value as JsonObject;
}

function digestOf(files: ReadonlyMap<string, Uint8Array>, path: string): Sha256Hex {
  const bytes = files.get(path);
  if (bytes === undefined) {
    throw new Error(`offline core file ${path} is missing; expected it among ${[...files.keys()].join(', ')}`);
  }
  return sha256Hex(bytes);
}

function recordBytes(record: JsonObject): Uint8Array {
  return serializeRecordFile(record as unknown as StudyRecord);
}
