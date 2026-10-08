// The production reader of the deployment projection (Owner amendment A-13; BR-RUA-007,
// BR-RUA-020): every value is read from the frozen run template and cited by its path and digest;
// a digest that is not the frozen one, an unreadable template or a missing resource is refused with
// every reason; an absent property is null, so a difference is never hidden; and the result is
// assignable to WP-16's DeploymentProjection without colliding with the manifest keys its sheets add.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { projectDeploymentTemplate } from '../../../src/deployment-assembly/deployment-projection.ts';
import { CORE_TEMPLATE_PATHS } from '../../../src/deployment-assembly/execution-template.ts';
import type { DeploymentTemplateProjection } from '../../../src/deployment-assembly/deployment-projection.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import type { DeploymentProjection } from '../../../src/study-comparison/equality-sheets.ts';
import {
  FIXTURE_IDS,
  propertiesAt,
  removeResource,
  runTemplate,
  templateBytes,
} from '../../support/deployment-assembly/execution-template-fixture.ts';

const TEMPLATE_PATH =
  'runs/3f1c2a9e-8b4d-4c1e-9f00-1a2b3c4d5e6f/admission/deployment-assembly/SucRua-run-3f1c2a9e.template.json';
/** The keys WP-16's sheets add from the execution manifest; the template projection never uses them. */
const MANIFEST_SHEET_KEYS = [
  'source_visibility_timeout_ms',
  'max_receive_count',
  'retry_jitter',
  'provider_version',
  'provider_warmup',
  'provider_client_deadline_ms',
  'invocation_timeout_ms',
  'http_handler',
];

function project(template: JsonObject = runTemplate()): ReturnType<typeof projectDeploymentTemplate> {
  const bytes = templateBytes(template);
  return projectDeploymentTemplate({
    template_path: TEMPLATE_PATH,
    template_bytes: bytes,
    template_sha256: sha256Hex(bytes),
  });
}

function projected(template?: JsonObject): DeploymentTemplateProjection {
  const result = project(template);
  if (!result.ok) {
    throw new Error(`projection refused: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function codes(result: ReturnType<typeof projectDeploymentTemplate>): readonly string[] {
  return result.ok ? [] : result.error.map((reason) => reason.code);
}

const SHARED = {
  provider_configuration: {
    runtime: 'nodejs24.x',
    architectures: ['x86_64'],
    memory_size_mb: 512,
    timeout_s: 30,
    environment_keys: ['SUC_EXECUTION_ID', 'SUC_TABLE_LEDGER'],
    reserved_concurrent_executions: null,
    provisioned_concurrency_config: null,
  },
  controller_configuration: {
    stream_view_type: 'NEW_IMAGE',
    starting_position: 'TRIM_HORIZON',
    batch_size: 1,
    maximum_batching_window_s: 0,
    parallelization_factor: 1,
    maximum_retry_attempts: 2,
    maximum_record_age_s: 3600,
    bisect_batch_on_function_error: false,
    filter_criteria: { Filters: [{ Pattern: '{"eventName":["INSERT"]}' }] },
    on_failure_destination: true,
  },
};

const PROTOCOL = {
  fifo: true,
  content_based_deduplication: false,
  redrive_max_receive_count: 2,
  dead_letter_queue_fifo: true,
  batch_size: 1,
  maximum_batching_window_s: null,
  scaling_config: null,
  provisioned_poller_config: null,
  filter_criteria: null,
  target_qualifier: 'alias',
};

const CALLER_TIMING = {
  runtime: 'nodejs24.x',
  architectures: ['x86_64'],
  memory_size_mb: 512,
  timeout_s: 10,
  provider_qualifier: 'version',
};

describe('projectDeploymentTemplate (A-13)', () => {
  it('reads every template-derived value of both variants and cites the template', () => {
    const bytes = templateBytes(runTemplate());
    assert.deepEqual(projected(), {
      variants: {
        conventional: {
          message_source_protocol: PROTOCOL,
          ...SHARED,
          caller_timing: CALLER_TIMING,
          caller_strategy: { execution_strategy: 'sqs_redelivery' },
        },
        durable: {
          message_source_protocol: PROTOCOL,
          ...SHARED,
          caller_timing: CALLER_TIMING,
          caller_strategy: {
            execution_strategy: 'durable_step_retry',
            durable_execution_timeout_s: 300,
            durable_retention_period_days: 1,
          },
        },
      },
      evidence_refs: [{ artifact_path: TEMPLATE_PATH, artifact_sha256: sha256Hex(bytes) }],
    });
  });

  it('is assignable to the DeploymentProjection the run comparison reads, without its manifest keys', () => {
    const projection: DeploymentProjection = projected();
    for (const sheet of Object.values(projection.variants)) {
      const sections: readonly JsonObject[] = [
        sheet.message_source_protocol,
        sheet.provider_configuration,
        sheet.controller_configuration,
        sheet.caller_timing,
        sheet.caller_strategy,
      ];
      const keys = sections.flatMap((section) => Object.keys(section));
      assert.deepEqual(
        keys.filter((key) => MANIFEST_SHEET_KEYS.includes(key)),
        [],
      );
    }
  });

  it('refuses bytes whose digest is not the frozen template digest', () => {
    const bytes = templateBytes(runTemplate());
    const result = projectDeploymentTemplate({
      template_path: TEMPLATE_PATH,
      template_bytes: bytes,
      template_sha256: sha256Hex(new Uint8Array()),
    });
    assert.deepEqual(codes(result), ['TEMPLATE_DIGEST_MISMATCH']);
    assert.equal(result.ok ? '' : result.error[0]?.subject, 'BR-RUA-007');
  });

  it('refuses an unreadable template with its reason', () => {
    const bytes = new TextEncoder().encode('[]');
    const result = projectDeploymentTemplate({
      template_path: TEMPLATE_PATH,
      template_bytes: bytes,
      template_sha256: sha256Hex(bytes),
    });
    assert.deepEqual(codes(result), ['TEMPLATE_UNREADABLE']);
  });

  it('names every missing core resource', () => {
    const template = runTemplate();
    for (const id of [
      FIXTURE_IDS.providerFunction,
      FIXTURE_IDS.providerVersion,
      FIXTURE_IDS.controllerMapping,
      FIXTURE_IDS.callerJournalTable,
    ]) {
      removeResource(template, id);
    }
    assert.deepEqual(codes(project(template)), Array<string>(4).fill('TEMPLATE_RESOURCE_MISSING'));
  });

  it('names only the missing core resource when the others are present', () => {
    const template = runTemplate();
    removeResource(template, FIXTURE_IDS.callerJournalTable);
    const result = project(template);
    assert.deepEqual(codes(result), ['TEMPLATE_RESOURCE_MISSING']);
    assert.ok(!result.ok);
    assert.ok(result.error[0]?.detail.includes(JSON.stringify(CORE_TEMPLATE_PATHS.callerJournalTable)));
  });

  it('names every missing resource of either variant', () => {
    const template = runTemplate();
    for (const id of [
      FIXTURE_IDS.conventionalCaller,
      FIXTURE_IDS.conventionalSource,
      FIXTURE_IDS.conventionalDeadLetter,
      FIXTURE_IDS.conventionalMapping,
      FIXTURE_IDS.durableMapping,
    ]) {
      removeResource(template, id);
    }
    assert.deepEqual(codes(project(template)), Array<string>(5).fill('TEMPLATE_RESOURCE_MISSING'));
    const durableOnly = runTemplate();
    removeResource(durableOnly, FIXTURE_IDS.durableSource);
    assert.deepEqual(codes(project(durableOnly)), ['TEMPLATE_RESOURCE_MISSING']);
  });

  it('distinguishes a mapping on a version, on the unqualified function and on an alias', () => {
    const template = runTemplate();
    propertiesAt(template, FIXTURE_IDS.conventionalMapping)['FunctionName'] = { Ref: FIXTURE_IDS.providerVersion };
    propertiesAt(template, FIXTURE_IDS.durableMapping)['FunctionName'] = { Ref: FIXTURE_IDS.durableCaller };
    const { conventional, durable } = projected(template).variants;
    assert.deepEqual(
      [conventional.message_source_protocol['target_qualifier'], durable.message_source_protocol['target_qualifier']],
      ['version', 'unqualified'],
    );
  });

  it('records an absent property as null and a present one as the template states it', () => {
    const template = runTemplate();
    delete propertiesAt(template, FIXTURE_IDS.conventionalMapping)['BatchSize'];
    propertiesAt(template, FIXTURE_IDS.durableMapping)['ScalingConfig'] = { MaximumConcurrency: 2 };
    propertiesAt(template, FIXTURE_IDS.providerFunction)['ReservedConcurrentExecutions'] = 1;
    delete propertiesAt(template, FIXTURE_IDS.providerFunction)['Environment'];
    delete propertiesAt(template, FIXTURE_IDS.controllerMapping)['DestinationConfig'];
    delete propertiesAt(template, FIXTURE_IDS.conventionalCaller)['Environment'];
    const { conventional, durable } = projected(template).variants;
    assert.equal(conventional.message_source_protocol['batch_size'], null);
    assert.deepEqual(durable.message_source_protocol['scaling_config'], { MaximumConcurrency: 2 });
    assert.equal(durable.provider_configuration['reserved_concurrent_executions'], 1);
    assert.equal(durable.provider_configuration['environment_keys'], null);
    assert.equal(durable.controller_configuration['on_failure_destination'], false);
    assert.equal(conventional.caller_timing['provider_qualifier'], 'unqualified');
  });

  it('reads a provisioned concurrency configuration on the provider version', () => {
    const template = runTemplate();
    propertiesAt(template, FIXTURE_IDS.providerVersion)['ProvisionedConcurrencyConfig'] = {
      ProvisionedConcurrentExecutions: 1,
    };
    assert.deepEqual(projected(template).variants.durable.provider_configuration['provisioned_concurrency_config'], {
      ProvisionedConcurrentExecutions: 1,
    });
  });

  it('reads a caller whose provider qualifier names an alias', () => {
    const template = runTemplate();
    const environment = propertiesAt(template, FIXTURE_IDS.durableCaller)['Environment'] as {
      Variables: Record<string, unknown>;
    };
    environment.Variables['SUC_PROVIDER_QUALIFIER'] = { Ref: FIXTURE_IDS.durableAlias };
    assert.equal(projected(template).variants.durable.caller_timing['provider_qualifier'], 'alias');
  });
});
