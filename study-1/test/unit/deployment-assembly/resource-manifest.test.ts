// The frozen resource manifest (design §9.8 D4; BR-RUA-040, BR-RUA-050, BR-RUA-053): `succeeded`
// exactly when no reason was found, otherwise `partial` when any resource was listed and `failed`
// when none was, with every reason; always valid against the resource_manifest schema; a declared
// tag set that is not a BR-RUA-050 set builds no manifest.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildResourceManifest, expectedStackName } from '../../../src/deployment-assembly/resource-manifest.ts';
import type {
  ResourceManifestBuild,
  ResourceManifestInput,
} from '../../../src/deployment-assembly/resource-manifest.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import {
  declaredTags,
  EXECUTION_ID,
  PROBE_IDENTITY,
  RUN_STACK,
  VALIDATION_IDENTITY,
} from '../../support/deployment-assembly/deployment-fixtures.ts';
import { RECORDED_STACK_ID } from '../../support/deployment-assembly/recorded-stack-resources.ts';
import {
  deployedReport,
  EXECUTION_MANIFEST_SHA256,
  succeededInput,
} from '../../support/deployment-assembly/resource-manifest-inputs.ts';

const validator = createRecordValidator();

function built(input: ResourceManifestInput): ResourceManifestBuild {
  const result = buildResourceManifest(input);
  if (!result.ok) {
    throw new Error(`declared tags refused: ${JSON.stringify(result.error)}`);
  }
  const verdict = validator.validateAs('resource_manifest', result.value.manifest as unknown as JsonValue);
  assert.ok(verdict.valid, `schema violations: ${JSON.stringify(verdict.valid ? [] : verdict.violations)}`);
  return result.value;
}

function summary(build: ResourceManifestBuild): readonly unknown[] {
  return [build.manifest.provisioning_status, build.reasons.map((reason) => reason.code)];
}

function stackIdOf(name: string): string {
  return RECORDED_STACK_ID.replace(RUN_STACK, name);
}

describe('buildResourceManifest', () => {
  it('builds a succeeded manifest with every reading when nothing is wrong', () => {
    const build = built(succeededInput());
    assert.deepEqual(build.reasons, []);
    const { manifest } = build;
    assert.equal(manifest.provisioning_status, 'succeeded');
    assert.deepEqual(
      {
        run_id: 'run_id' in manifest ? manifest.run_id : '',
        stack_name: manifest.stack_name,
        stack_id: manifest.stack_id,
        provider_version: manifest.provider_version,
        resources: manifest.resources.length,
        tags: manifest.ownership_tags.map((tag) => tag.key),
        outputs: manifest.outputs,
        configuration: manifest.configuration,
        times: [manifest.deploy_started_at, manifest.deploy_completed_at, manifest.frozen_at],
        digest: manifest.execution_manifest_sha256,
      },
      {
        run_id: EXECUTION_ID,
        stack_name: RUN_STACK,
        stack_id: RECORDED_STACK_ID,
        provider_version: '7',
        resources: 16,
        tags: ['suc:expires_at', 'suc:managed_by', 'suc:project', 'suc:run_id', 'suc:study_id'],
        outputs: deployedReport().outputs,
        configuration: [
          { logical_id: 'DurableMapping', attribute_path: 'BatchSize', canonical_json: '1' },
          { logical_id: 'DurableSource', attribute_path: 'VisibilityTimeout', canonical_json: '360' },
        ],
        times: ['2026-10-05T12:01:00.000Z', '2026-10-05T12:04:00.000Z', '2026-10-05T12:05:00.000Z'],
        digest: EXECUTION_MANIFEST_SHA256,
      },
    );
    assert.deepEqual(Object.keys(manifest).slice(0, 3), ['schema_version', 'record_type', 'run_id']);
  });

  it('names the stack of a probe and of a variant validation', () => {
    for (const [identity, name] of [
      [PROBE_IDENTITY, 'SucRua-probe-3f1c2a9e'],
      [VALIDATION_IDENTITY, 'SucRua-validation-3f1c2a9e'],
    ] as const) {
      const tags =
        identity.execution_kind === 'VARIANT_VALIDATION'
          ? [...declaredTags(), { key: 'suc:variant_id', value: 'durable' }]
          : declaredTags();
      const build = built(
        succeededInput({
          identity,
          declared_tags: tags,
          deploy: deployedReport({ stack_name: name }),
          stack: { stack_id: stackIdOf(name), stack_status: 'UPDATE_COMPLETE', tags },
        }),
      );
      assert.deepEqual(summary(build), ['succeeded', []]);
      assert.equal(build.manifest.stack_name, name);
      assert.equal(expectedStackName(identity), name);
    }
  });

  it('builds no manifest for a declared tag set that is not BR-RUA-050', () => {
    const result = buildResourceManifest(succeededInput({ declared_tags: declaredTags().slice(1) }));
    assert.deepEqual(result.ok ? [] : result.error.map((reason) => reason.code), ['OWNERSHIP_TAG_INVALID']);
  });

  it('is partial with the deploy reasons when the deployment failed but resources were listed', () => {
    const failure = { code: 'DEPLOY_COMMAND_FAILED', subject: 'BR-RUA-040', detail: 'exited 1' };
    const build = built(
      succeededInput({ deploy: deployedReport({ deployed: false, outputs: [], reasons: [failure] }) }),
    );
    assert.deepEqual(summary(build), ['partial', ['DEPLOY_FAILED', 'DEPLOY_COMMAND_FAILED']]);
    assert.equal(build.manifest.provider_version, '7');
  });

  it('refuses a deployment of another stack name', () => {
    const build = built(succeededInput({ deploy: deployedReport({ stack_name: 'SucRua-run-00000000' }) }));
    assert.deepEqual(summary(build), ['partial', ['STACK_NAME_MISMATCH']]);
    assert.equal(build.manifest.stack_name, RUN_STACK);
  });

  it('is partial without a stack id when the stack was not described or its id is not that stack', () => {
    const undescribed = built(succeededInput({ stack: undefined }));
    assert.deepEqual(summary(undescribed), ['partial', ['STACK_NOT_DESCRIBED']]);
    assert.equal(undescribed.manifest.stack_id, undefined);
    for (const stackId of ['not-an-arn', stackIdOf('SucRua-run-00000000')]) {
      const build = built(
        succeededInput({ stack: { stack_id: stackId, stack_status: 'CREATE_COMPLETE', tags: declaredTags() } }),
      );
      assert.deepEqual(summary(build), ['partial', ['STACK_ID_INVALID']]);
      assert.equal(build.manifest.stack_id, undefined);
    }
  });

  it('keeps the stack id of a stack that is not complete, with the reason', () => {
    const build = built(
      succeededInput({
        stack: { stack_id: RECORDED_STACK_ID, stack_status: 'UPDATE_ROLLBACK_COMPLETE', tags: declaredTags() },
      }),
    );
    assert.deepEqual(summary(build), ['partial', ['STACK_NOT_COMPLETE']]);
    assert.equal(build.manifest.stack_id, RECORDED_STACK_ID);
  });

  it('refuses a stack whose observed tags differ from the declared ones', () => {
    const build = built(
      succeededInput({
        stack: { stack_id: RECORDED_STACK_ID, stack_status: 'CREATE_COMPLETE', tags: declaredTags().slice(1) },
      }),
    );
    assert.deepEqual(summary(build), ['partial', ['OWNERSHIP_TAG_MISMATCH']]);
  });

  it('is failed when the resources were not listed or none was', () => {
    const unlisted = built(succeededInput({ resources: undefined }));
    assert.deepEqual(summary(unlisted), ['failed', ['RESOURCES_NOT_LISTED', 'PROVIDER_VERSION_UNKNOWN']]);
    assert.equal(unlisted.manifest.provider_version, undefined);
    const none = built(succeededInput({ resources: [] }));
    assert.deepEqual(summary(none), ['failed', ['PROVIDER_VERSION_UNKNOWN']]);
  });

  it('is partial, without a configuration, when no configuration attribute was read', () => {
    const build = built(succeededInput({ configuration: [] }));
    assert.deepEqual(summary(build), ['partial', ['CONFIGURATION_MISSING']]);
    assert.equal('configuration' in build.manifest, false);
  });

  it('carries the reasons of resources, configuration and outputs it left out', () => {
    const input = succeededInput();
    const build = built({
      ...input,
      resources: [
        ...(input.resources ?? []),
        { logical_id: 'Late', resource_type: 'AWS::SQS::Queue', resource_status: 'CREATE_IN_PROGRESS' },
      ],
      configuration: [...input.configuration, { logical_id: 'DurableMapping', attribute_path: 'BatchSize', value: 10 }],
      deploy: deployedReport({ outputs: [{ key: 'Bad-Key', value: 'x' }] }),
    });
    assert.deepEqual(summary(build), [
      'partial',
      ['RESOURCE_NOT_COMPLETE', 'CONFIGURATION_CONFLICT', 'OUTPUT_INVALID'],
    ]);
    assert.equal(build.manifest.configuration?.length, 2);
  });
});
