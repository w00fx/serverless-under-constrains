// The per-trial field sheets of the eight BR-RUA-007 projections (design §8.14 table): each value is
// read from frozen evidence, and a projection whose evidence is absent is `missing` with an
// ARTIFACT_MISSING reason naming the absent artifact.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import type { ResourceManifest } from '../../../src/record-contract/records/group-a/resource_manifest.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { buildTrialSheets } from '../../../src/study-comparison/equality-sheets.ts';
import type { ProjectionInput, TrialSheetSources } from '../../../src/study-comparison/equality-sheets.ts';
import type { RunPackageRecords } from '../../../src/study-comparison/run-package-reader.ts';
import { specDeploymentProjection } from '../../golden/study-comparison/support/golden-run.ts';
import { cleanRunRecords, trialFile } from './support/clean-run.ts';

let records: RunPackageRecords;

before(async () => {
  records = await cleanRunRecords();
});

function sources(index: 0 | 1 | 2 | 3): TrialSheetSources {
  const trial = records.trial_records[index];
  return {
    trial: trial.trial,
    execution_manifest: records.execution_manifest,
    resource_manifest: records.resource_manifest,
    provider_configuration: trial.provider_configuration,
    payment: trial.payment,
    approved_decision: trial.approved_decision,
    deployment: specDeploymentProjection(records.execution_manifest.ref.artifact_sha256),
  };
}

function sheetOf(input: ProjectionInput): Exclude<ProjectionInput, { readonly missing: unknown }>['sheet'] {
  assert.ok('sheet' in input, `expected a sheet, got ${JSON.stringify(input)}`);
  return input.sheet;
}

function missingOf(
  input: ProjectionInput,
): readonly { readonly code: string; readonly subject: string; readonly artifact_path?: string }[] {
  assert.ok('missing' in input, `expected missing, got ${JSON.stringify(input)}`);
  return input.missing.map(({ code, subject, artifact_path }) =>
    artifact_path === undefined ? { code, subject } : { code, subject, artifact_path },
  );
}

describe('buildTrialSheets', () => {
  it('names the trial and builds all eight projections from frozen evidence', () => {
    const built = buildTrialSheets(sources(0));
    const trial = records.trial_records[0].trial;
    assert.deepEqual(
      [built.trial_id, built.variant_id, built.scenario],
      [trial.trial_id, trial.variant_id, trial.scenario],
    );
    assert.deepEqual(Object.keys(built.projections), [
      'financial_inputs',
      'control_parameters',
      'treatment_parameters',
      'message_source_protocol',
      'provider_configuration',
      'controller_configuration',
      'caller_timing',
      'observation_window',
    ]);
    for (const input of Object.values(built.projections)) {
      assert.ok('sheet' in input);
    }
  });

  it('compares the payment and approved decision by digest', () => {
    const source = sources(1);
    const sheet = sheetOf(buildTrialSheets(source).projections.financial_inputs);
    assert.deepEqual(sheet.common, {
      payment_sha256: source.payment?.artifact_sha256,
      approved_decision_sha256: source.approved_decision?.artifact_sha256,
    });
    assert.deepEqual(sheet.evidence_refs, [source.payment, source.approved_decision]);
  });

  it('reads the control and treatment parameters from the frozen provider configuration and manifest timing', () => {
    const source = sources(0);
    const configuration = source.provider_configuration?.record;
    const { timing } = records.execution_manifest.record;
    const built = buildTrialSheets(source).projections;
    assert.deepEqual(sheetOf(built.control_parameters).common, {
      scenario: configuration?.scenario,
      safety_release_ms: configuration?.safety_release_ms,
      treatment_poll_interval_ms: configuration?.treatment_poll_interval_ms,
    });
    const treatment = sheetOf(built.treatment_parameters);
    assert.deepEqual(treatment.common, {
      provider_client_deadline_ms: timing.provider_client_deadline_ms,
      provider_safety_release_ms: configuration?.safety_release_ms,
      provider_execution_timeout_ms: timing.provider_execution_timeout_ms,
      treatment_poll_interval_ms: configuration?.treatment_poll_interval_ms,
      arming_scenario: configuration?.scenario,
    });
    assert.deepEqual(treatment.evidence_refs[0], { ...records.execution_manifest.ref, json_pointer: '/timing' });
  });

  it('takes each variant its own source visibility timeout and invocation timeout', () => {
    const { timing } = records.execution_manifest.record;
    const byVariant = [0, 1, 2, 3].map((index) => {
      const built = buildTrialSheets(sources(index as 0 | 1 | 2 | 3));
      return [
        built.variant_id,
        sheetOf(built.projections.message_source_protocol).common['source_visibility_timeout_ms'],
        sheetOf(built.projections.caller_timing).common['invocation_timeout_ms'],
      ];
    });
    for (const [variant, visibility, invocation] of byVariant) {
      const durable = variant === 'durable';
      assert.equal(
        visibility,
        durable ? timing.durable_visibility_timeout_ms : timing.conventional_visibility_timeout_ms,
      );
      assert.equal(
        invocation,
        durable ? timing.durable_invocation_timeout_ms : timing.conventional_invocation_timeout_ms,
      );
    }
    assert.deepEqual(new Set(byVariant.map(([variant]) => variant)), new Set(['conventional', 'durable']));
  });

  it('compares the Durable retry policy within the Durable variant only', () => {
    const { timing } = records.execution_manifest.record;
    for (const index of [0, 1, 2, 3] as const) {
      const built = buildTrialSheets(sources(index));
      const within = sheetOf(built.projections.caller_timing).within_variant;
      if (built.variant_id === 'durable') {
        assert.equal(within['durable_total_step_attempts'], timing.durable_total_step_attempts);
        assert.equal(within['durable_retry_delay_ms'], timing.durable_retry_delay_ms);
        assert.equal(within['durable_execution_timeout_ms'], timing.durable_execution_timeout_ms);
        assert.equal(within['execution_strategy'], 'durable_step_retry');
      } else {
        assert.deepEqual(within, { execution_strategy: 'sqs_redelivery' });
      }
    }
  });

  it('adds the provider version and the warm-up policy to the provider configuration', () => {
    const sheet = sheetOf(buildTrialSheets(sources(2)).projections.provider_configuration);
    const resources = records.resource_manifest?.record;
    assert.equal(sheet.common['provider_version'], resources?.provider_version);
    assert.deepEqual(sheet.common['provider_warmup'], {
      invocations_per_trial: records.execution_manifest.record.provider_warmup.invocations_per_trial,
    });
    assert.ok(sheet.evidence_refs.some((ref) => ref.artifact_path === EXECUTION_PATHS.resourceManifest));
  });

  it('reads the observation window from the manifest timing', () => {
    const { timing } = records.execution_manifest.record;
    assert.deepEqual(sheetOf(buildTrialSheets(sources(3)).projections.observation_window).common, {
      observation_deadline_ms: timing.observation_deadline_ms,
      stabilization_interval_ms: timing.stabilization_interval_ms,
      queue_poll_interval_ms: timing.queue_poll_interval_ms,
    });
  });

  it('names both absent financial inputs, or the one that is absent', () => {
    const source = sources(0);
    const id = source.trial.trial_id;
    const payment = { code: 'ARTIFACT_MISSING', subject: 'financial_inputs', artifact_path: trialFile(id, 'payment') };
    const decision = {
      code: 'ARTIFACT_MISSING',
      subject: 'financial_inputs',
      artifact_path: trialFile(id, 'approvedDecision'),
    };
    const without = (patch: Partial<TrialSheetSources>): ProjectionInput =>
      buildTrialSheets({ ...source, ...patch }).projections.financial_inputs;
    assert.deepEqual(missingOf(without({ payment: undefined, approved_decision: undefined })), [payment, decision]);
    assert.deepEqual(missingOf(without({ payment: undefined })), [payment]);
    assert.deepEqual(missingOf(without({ approved_decision: undefined })), [decision]);
  });

  it('marks the control and treatment parameters missing without a provider configuration', () => {
    const source = sources(0);
    const path = trialFile(source.trial.trial_id, 'providerTrialConfiguration');
    const built = buildTrialSheets({ ...source, provider_configuration: undefined }).projections;
    assert.deepEqual(missingOf(built.control_parameters), [
      { code: 'ARTIFACT_MISSING', subject: 'control_parameters', artifact_path: path },
    ]);
    assert.deepEqual(missingOf(built.treatment_parameters), [
      { code: 'ARTIFACT_MISSING', subject: 'treatment_parameters', artifact_path: path },
    ]);
  });

  it('marks every template projection missing without a deployment projection, naming the template', () => {
    const template = records.execution_manifest.record.deployment_assembly.template_path;
    const built = buildTrialSheets({ ...sources(1), deployment: undefined }).projections;
    for (const id of [
      'message_source_protocol',
      'provider_configuration',
      'controller_configuration',
      'caller_timing',
    ] as const) {
      assert.deepEqual(missingOf(built[id]), [{ code: 'ARTIFACT_MISSING', subject: id, artifact_path: template }]);
    }
    assert.ok('sheet' in built.observation_window);
  });

  it('marks the provider configuration missing without a resource manifest or its provider version', () => {
    const source = sources(1);
    const absent = buildTrialSheets({ ...source, resource_manifest: undefined }).projections.provider_configuration;
    assert.deepEqual(missingOf(absent), [
      { code: 'ARTIFACT_MISSING', subject: 'provider_configuration', artifact_path: EXECUTION_PATHS.resourceManifest },
    ]);
    assert.ok('missing' in absent && absent.missing[0].detail.startsWith('the resource manifest is absent'));
    const frozen = records.resource_manifest;
    assert.ok(frozen !== undefined);
    const { provider_version: _omitted, ...rest } = frozen.record;
    const failed: ResourceManifest = { ...rest, provisioning_status: 'failed' };
    const unnamed = buildTrialSheets({ ...source, resource_manifest: { ...frozen, record: failed } }).projections
      .provider_configuration;
    assert.ok(
      'missing' in unnamed && unnamed.missing[0].detail.startsWith('the resource manifest names no provider version'),
    );
  });
});
