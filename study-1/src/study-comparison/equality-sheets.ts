// The per-trial field sheets the BR-RUA-007 equality projections compare (design §8.14 table).
// Every value comes from frozen evidence, never from runtime telemetry: the execution manifest
// (OR-RUA-001/002 timing, the addendum warm-up policy), the resource manifest's provider version,
// each trial's frozen provider configuration and input bytes, and the deployment projection of the
// inventoried template.
//
// The deployment projection is an input. Reading the run stack's construct paths out of the frozen
// template belongs to the deployment-assembly composition that defines those paths (WP-24/WP-26);
// this feature compares what that projection states and cites the evidence it names
// (evidence/WP-16/decisions.md).

import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import type { JsonObject, Scenario, StructuredReason, Uuid4, VariantId } from '../record-contract/primitives.ts';
import type { DeclaredTrial, ExecutionManifest } from '../record-contract/records/group-a/execution_manifest.ts';
import type { ProviderTrialConfiguration } from '../record-contract/records/group-a/provider_trial_configuration.ts';
import type { ResourceManifest } from '../record-contract/records/group-a/resource_manifest.ts';
import type { ArtifactRef } from '../record-contract/records/group-c/shared-shapes.ts';
import type { EqualityProjectionId } from '../record-contract/records/group-c/vocabulary.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import { comparisonReason } from './comparison-reasons.ts';
import type { FrozenRecord } from './record-files.ts';

/** The fields one trial contributes to one projection, and the evidence they come from. */
export interface ProjectionSheet {
  /** Compared across every trial the projection covers. */
  readonly common: JsonObject;
  /**
   * Compared only between covered trials of the same variant: the settings of a variant's own
   * execution strategy, which design §8.14 declares as variant differences (Durable step attempts,
   * retry delay, execution timeout, retention, execution-strategy code).
   */
  readonly within_variant: JsonObject;
  readonly evidence_refs: readonly EvidenceRef[];
}

/** A sheet, or the reasons it could not be built from the frozen evidence. */
export type ProjectionInput =
  { readonly sheet: ProjectionSheet } | { readonly missing: readonly [StructuredReason, ...StructuredReason[]] };

/** One trial as the equality evaluation sees it (design §5.3 `ComparisonTrialInputs`). */
export interface ComparisonTrialInputs {
  readonly trial_id: Uuid4;
  readonly variant_id: VariantId;
  readonly scenario: Scenario;
  readonly projections: Readonly<Record<EqualityProjectionId, ProjectionInput>>;
}

/** The template-derived values of one variant, per projection that reads the template. */
export interface VariantDeploymentSheet {
  readonly message_source_protocol: JsonObject;
  readonly provider_configuration: JsonObject;
  readonly controller_configuration: JsonObject;
  readonly caller_timing: JsonObject;
  /** The variant's own execution-strategy settings, compared within the variant only. */
  readonly caller_strategy: JsonObject;
}

/** The inventoried template's projection, per variant, with the evidence it was read from. */
export interface DeploymentProjection {
  readonly variants: Readonly<Record<VariantId, VariantDeploymentSheet>>;
  readonly evidence_refs: readonly [EvidenceRef, ...EvidenceRef[]];
}

/** The frozen evidence of one declared trial that its sheets are built from. */
export interface TrialSheetSources {
  readonly trial: DeclaredTrial;
  readonly execution_manifest: FrozenRecord<ExecutionManifest>;
  readonly resource_manifest: FrozenRecord<ResourceManifest> | undefined;
  readonly provider_configuration: FrozenRecord<ProviderTrialConfiguration> | undefined;
  /** The stored payment and approved-decision bytes, by digest. */
  readonly payment: ArtifactRef | undefined;
  readonly approved_decision: ArtifactRef | undefined;
  readonly deployment: DeploymentProjection | undefined;
}

type SheetResult = ProjectionInput;

const NO_FIELDS: JsonObject = {};

/**
 * Builds the eight projection inputs of one trial. A projection whose evidence is absent is
 * `missing` with an `ARTIFACT_MISSING` reason naming the absent artifact (BR-RUA-035).
 *
 * @example
 * const inputs = buildTrialSheets({ trial, execution_manifest, resource_manifest, provider_configuration,
 *   payment, approved_decision, deployment });
 * inputs.projections.observation_window; // { sheet: { common: { observation_deadline_ms: 600000, ... } } }
 */
export function buildTrialSheets(sources: TrialSheetSources): ComparisonTrialInputs {
  const { trial } = sources;
  return {
    trial_id: trial.trial_id,
    variant_id: trial.variant_id,
    scenario: trial.scenario,
    projections: {
      financial_inputs: financialSheet(sources),
      control_parameters: controlSheet(sources),
      treatment_parameters: treatmentSheet(sources),
      message_source_protocol: messageSourceSheet(sources),
      provider_configuration: providerSheet(sources),
      controller_configuration: controllerSheet(sources),
      caller_timing: callerTimingSheet(sources),
      observation_window: observationSheet(sources),
    },
  };
}

function financialSheet(sources: TrialSheetSources): SheetResult {
  const { payment, approved_decision: decision, trial } = sources;
  if (payment === undefined) {
    return missingFiles(
      trial,
      'financial_inputs',
      'payment',
      ...(decision === undefined ? ['approvedDecision' as const] : []),
    );
  }
  if (decision === undefined) {
    return missingFiles(trial, 'financial_inputs', 'approvedDecision');
  }
  return sheet(
    { payment_sha256: payment.artifact_sha256, approved_decision_sha256: decision.artifact_sha256 },
    NO_FIELDS,
    [payment, decision],
  );
}

// "Provider configuration of both CONTROL trials, minus ids": the identities, digests and write
// time are left out, so what remains is the configuration the provider ran with.
function controlSheet(sources: TrialSheetSources): SheetResult {
  const configuration = sources.provider_configuration;
  if (configuration === undefined) {
    return missingFiles(sources.trial, 'control_parameters', 'providerTrialConfiguration');
  }
  const { record } = configuration;
  return sheet(
    {
      scenario: record.scenario,
      safety_release_ms: record.safety_release_ms,
      treatment_poll_interval_ms: record.treatment_poll_interval_ms,
    },
    NO_FIELDS,
    [configuration.ref],
  );
}

// Deadline 3 s, safety release 15 s, provider timeout 30 s, barrier polling 250 ms, arming rule.
// The safety release, the polling and the armed scenario are what the trial's provider actually
// ran with; the deadline and the timeout are the manifest's single declaration.
function treatmentSheet(sources: TrialSheetSources): SheetResult {
  const configuration = sources.provider_configuration;
  if (configuration === undefined) {
    return missingFiles(sources.trial, 'treatment_parameters', 'providerTrialConfiguration');
  }
  const { timing } = sources.execution_manifest.record;
  const { record } = configuration;
  return sheet(
    {
      provider_client_deadline_ms: timing.provider_client_deadline_ms,
      provider_safety_release_ms: record.safety_release_ms,
      provider_execution_timeout_ms: timing.provider_execution_timeout_ms,
      treatment_poll_interval_ms: record.treatment_poll_interval_ms,
      arming_scenario: record.scenario,
    },
    NO_FIELDS,
    [manifestRef(sources, '/timing'), configuration.ref],
  );
}

// The source `VisibilityTimeout` is the declared difference (BR-RUA-020); the rest of the source
// protocol is the template's.
function messageSourceSheet(sources: TrialSheetSources): SheetResult {
  const { deployment, trial } = sources;
  if (deployment === undefined) {
    return missingDeployment(sources, 'message_source_protocol');
  }
  const { timing } = sources.execution_manifest.record;
  return sheet(
    {
      ...deployment.variants[trial.variant_id].message_source_protocol,
      source_visibility_timeout_ms:
        trial.variant_id === 'durable'
          ? timing.durable_visibility_timeout_ms
          : timing.conventional_visibility_timeout_ms,
      max_receive_count: timing.max_receive_count,
      retry_jitter: timing.retry_jitter,
    },
    NO_FIELDS,
    [...deployment.evidence_refs, manifestRef(sources, '/timing')],
  );
}

// The same provider version, the template's function settings and the warm-up policy (addendum:
// one warm-up invocation per trial replaces provisioned concurrency).
function providerSheet(sources: TrialSheetSources): SheetResult {
  const { deployment, resource_manifest: resources } = sources;
  if (deployment === undefined) {
    return missingDeployment(sources, 'provider_configuration');
  }
  if (resources?.record.provider_version === undefined) {
    return missing(
      comparisonReason(
        'ARTIFACT_MISSING',
        'provider_configuration',
        `${resources === undefined ? 'the resource manifest is absent' : 'the resource manifest names no provider version'}; expected the immutable provider version of a succeeded provisioning`,
        resources?.ref.artifact_path ?? EXECUTION_PATHS.resourceManifest,
      ),
    );
  }
  const manifest = sources.execution_manifest.record;
  return sheet(
    {
      ...deployment.variants[sources.trial.variant_id].provider_configuration,
      provider_version: resources.record.provider_version,
      provider_warmup: { invocations_per_trial: manifest.provider_warmup.invocations_per_trial },
    },
    NO_FIELDS,
    [...deployment.evidence_refs, resources.ref, manifestRef(sources, '/provider_warmup')],
  );
}

function controllerSheet(sources: TrialSheetSources): SheetResult {
  const { deployment } = sources;
  if (deployment === undefined) {
    return missingDeployment(sources, 'controller_configuration');
  }
  return sheet(
    deployment.variants[sources.trial.variant_id].controller_configuration,
    NO_FIELDS,
    deployment.evidence_refs,
  );
}

// The provider-client deadline and the caller timeout are common; the Durable retry policy is the
// Durable strategy's own and is compared between the Durable trials only.
function callerTimingSheet(sources: TrialSheetSources): SheetResult {
  const { deployment, trial } = sources;
  if (deployment === undefined) {
    return missingDeployment(sources, 'caller_timing');
  }
  const { timing } = sources.execution_manifest.record;
  const variant = deployment.variants[trial.variant_id];
  const durable = trial.variant_id === 'durable';
  return sheet(
    {
      ...variant.caller_timing,
      provider_client_deadline_ms: timing.provider_client_deadline_ms,
      invocation_timeout_ms: durable ? timing.durable_invocation_timeout_ms : timing.conventional_invocation_timeout_ms,
    },
    durable
      ? {
          ...variant.caller_strategy,
          durable_total_step_attempts: timing.durable_total_step_attempts,
          durable_retry_delay_ms: timing.durable_retry_delay_ms,
          durable_execution_timeout_ms: timing.durable_execution_timeout_ms,
        }
      : variant.caller_strategy,
    [...deployment.evidence_refs, manifestRef(sources, '/timing')],
  );
}

function observationSheet(sources: TrialSheetSources): SheetResult {
  const { timing } = sources.execution_manifest.record;
  return sheet(
    {
      observation_deadline_ms: timing.observation_deadline_ms,
      stabilization_interval_ms: timing.stabilization_interval_ms,
      queue_poll_interval_ms: timing.queue_poll_interval_ms,
    },
    NO_FIELDS,
    [manifestRef(sources, '/timing')],
  );
}

function sheet(common: JsonObject, withinVariant: JsonObject, refs: readonly EvidenceRef[]): SheetResult {
  return { sheet: { common, within_variant: withinVariant, evidence_refs: refs } };
}

function manifestRef(sources: TrialSheetSources, pointer: string): EvidenceRef {
  return { ...sources.execution_manifest.ref, json_pointer: pointer };
}

function missing(first: StructuredReason, ...rest: readonly StructuredReason[]): SheetResult {
  return { missing: [first, ...rest] };
}

type TrialFile = 'payment' | 'approvedDecision' | 'providerTrialConfiguration';

function missingFiles(
  trial: DeclaredTrial,
  projection: EqualityProjectionId,
  file: TrialFile,
  ...more: readonly TrialFile[]
): SheetResult {
  const reasonFor = (absent: TrialFile): StructuredReason => {
    const path = PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: trial.trial_id }, absent);
    return comparisonReason(
      'ARTIFACT_MISSING',
      projection,
      `${path} is absent; expected the frozen file of trial ${trial.trial_id}`,
      path,
    );
  };
  return missing(reasonFor(file), ...more.map(reasonFor));
}

function missingDeployment(sources: TrialSheetSources, projection: EqualityProjectionId): SheetResult {
  const template = sources.execution_manifest.record.deployment_assembly.template_path;
  return missing(
    comparisonReason(
      'ARTIFACT_MISSING',
      projection,
      `no projection of the inventoried template ${template} was supplied; expected the deployment projection the comparison reads`,
      template,
    ),
  );
}
