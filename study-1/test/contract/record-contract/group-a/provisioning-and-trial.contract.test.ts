// AC-RUA-046 (group A) record contracts of provisioning and trial state: the resource manifest
// (BR-RUA-040, BR-RUA-050, BR-RUA-053), the trial manifest (BR-RUA-040), the provider trial
// configuration (BR-RUA-025, BR-RUA-018, D-09) and the trial registration (BR-RUA-036, D-21).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EXPIRES_AT_TAG_KEY,
  MANAGED_BY_TAG,
  PROJECT_TAG,
  RUN_ID_TAG_KEY,
  STUDY_TAG,
  VARIANT_TAG_KEY,
} from '../../../../infra/ownership/ownership-tags.ts';
import {
  OWNERSHIP_TAG_KEYS,
  PROVISIONING_STATUSES,
} from '../../../../src/record-contract/records/group-a/resource_manifest.ts';
import {
  failedResourceManifest,
  probeProviderConfiguration,
  runOwnershipTags,
  succeededResourceManifest,
  trialManifest,
  trialProviderConfiguration,
  trialRegistration,
} from './support/manifest-examples.ts';
import { FIXTURE, IDS } from './support/sample-values.ts';
import {
  assertAccepted,
  assertRejected,
  withField,
  withPath,
  withoutField,
  withoutPath,
} from './support/validation-assertions.ts';

describe('resource_manifest (BR-RUA-040, BR-RUA-050)', () => {
  it('accepts every provisioning status', () => {
    assert.deepEqual(PROVISIONING_STATUSES, ['succeeded', 'partial', 'failed']);
    assertAccepted(succeededResourceManifest(), 'succeeded');
    assertAccepted(failedResourceManifest(), 'failed');
    assertAccepted(withField(failedResourceManifest(), 'provisioning_status', 'partial'), 'partial');
    assertRejected(
      withField(failedResourceManifest(), 'provisioning_status', 'running'),
      '/provisioning_status enum',
      'running',
    );
  });

  it('lets trials start only from a complete succeeded manifest', () => {
    for (const field of ['stack_id', 'provider_version', 'configuration', 'deploy_completed_at']) {
      assertRejected(withoutField(succeededResourceManifest(), field), ' required', `succeeded without ${field}`);
    }
    assertRejected(
      withField(succeededResourceManifest(), 'resources', []),
      '/resources minItems',
      'succeeded without resources',
    );
  });

  it('snapshots post-deploy configuration as attribute entries with canonical JSON text (BR-RUA-033)', () => {
    const entry = ['configuration', 0] as const;
    assertRejected(
      withField(succeededResourceManifest(), 'configuration', { FunctionName: null, MemorySize: 512 }),
      '/configuration type',
      'AWS-keyed object with a null',
    );
    assertRejected(withField(succeededResourceManifest(), 'configuration', []), '/configuration minItems', 'empty');
    assertAccepted(withField(failedResourceManifest(), 'configuration', []), 'a failed deploy read nothing');
    assertRejected(
      withPath(succeededResourceManifest(), [...entry, 'canonical_json'], 1),
      '/configuration/0/canonical_json type',
      'raw value',
    );
    assertRejected(
      withPath(succeededResourceManifest(), [...entry, 'canonical_json'], null),
      '/configuration/0/canonical_json type',
      'null value',
    );
    assertRejected(
      withPath(succeededResourceManifest(), [...entry, 'canonical_json'], ''),
      '/configuration/0/canonical_json minLength',
      'empty text',
    );
    assertRejected(
      withPath(succeededResourceManifest(), [...entry, 'attribute_path'], 'Batch Size'),
      '/configuration/0/attribute_path pattern',
      'attribute path',
    );
    assertRejected(
      withPath(succeededResourceManifest(), [...entry, 'logical_id'], 'Controller-Mapping'),
      '/configuration/0/logical_id pattern',
      'logical id',
    );
    assertRejected(
      withoutPath(succeededResourceManifest(), [...entry, 'canonical_json']),
      '/configuration/0 required',
      'no value',
    );
  });

  it('records the immutable provider version, never $LATEST or an alias (BR-RUA-053)', () => {
    for (const version of ['$LATEST', 'live', '0', '01', '']) {
      assertRejected(
        withField(succeededResourceManifest(), 'provider_version', version),
        '/provider_version pattern',
        version,
      );
    }
  });

  it('records the BR-RUA-050 ownership tags, each once', () => {
    assert.deepEqual(OWNERSHIP_TAG_KEYS, [
      'suc:project',
      'suc:study_id',
      'suc:run_id',
      'suc:managed_by',
      'suc:expires_at',
      'suc:variant_id',
    ]);
    // The keys the WP-00 infrastructure applies are the keys the manifest records.
    assert.deepEqual(
      [PROJECT_TAG.key, STUDY_TAG.key, RUN_ID_TAG_KEY, MANAGED_BY_TAG.key, EXPIRES_AT_TAG_KEY, VARIANT_TAG_KEY],
      OWNERSHIP_TAG_KEYS,
    );
    const tags = runOwnershipTags();
    for (const missing of OWNERSHIP_TAG_KEYS.slice(0, 5)) {
      assertRejected(
        withField(
          succeededResourceManifest(),
          'ownership_tags',
          tags.filter((tag) => tag.key !== missing),
        ),
        '/ownership_tags contains',
        `without ${missing}`,
      );
    }
    assertRejected(
      withField(succeededResourceManifest(), 'ownership_tags', [tags[0]]),
      '/ownership_tags minItems',
      'a generic project tag alone',
    );
    assertRejected(
      withField(succeededResourceManifest(), 'ownership_tags', [...tags, { key: 'suc:run_id', value: IDS.trial1 }]),
      '/ownership_tags contains',
      'two run ids',
    );
    const variantTag = { key: 'suc:variant_id', value: 'durable' };
    assertAccepted(withField(succeededResourceManifest(), 'ownership_tags', [...tags, variantTag]), 'variant tag');
    assertRejected(
      withField(succeededResourceManifest(), 'ownership_tags', [
        ...tags,
        variantTag,
        { key: 'suc:variant_id', value: 'conventional' },
      ]),
      '/ownership_tags contains',
      'two variant tags',
    );
    assertAccepted(
      withField(succeededResourceManifest(), 'ownership_tags', tags.toReversed()),
      'tag order has no meaning',
    );
    assertRejected(
      withPath(succeededResourceManifest(), ['ownership_tags', 0, 'key'], 'Project'),
      '/ownership_tags/0/key enum',
      'key',
    );
    assertRejected(
      withPath(succeededResourceManifest(), ['ownership_tags', 0, 'key'], 'suc:trial_id'),
      '/ownership_tags/0/key enum',
      'trial identity is never a resource tag',
    );
    assertRejected(
      withPath(succeededResourceManifest(), ['ownership_tags', 0, 'value'], 'a@b'),
      '/ownership_tags/0/value pattern',
      '@',
    );
    assertRejected(
      withField(succeededResourceManifest(), 'ownership_tags', []),
      '/ownership_tags minItems',
      'untagged',
    );
  });

  it('names the stack deterministically and records CloudFormation statuses', () => {
    assertRejected(
      withField(succeededResourceManifest(), 'stack_name', 'MyStack'),
      '/stack_name pattern',
      'stack name',
    );
    assertRejected(
      withPath(succeededResourceManifest(), ['resources', 0, 'resource_status'], 'create_complete'),
      '/resources/0/resource_status pattern',
      'status',
    );
  });
});

describe('trial_manifest (BR-RUA-040)', () => {
  it('accepts a run trial and a variant-validation trial', () => {
    assertAccepted(trialManifest(), 'run trial');
    const validationTrial = {
      ...withoutField(trialManifest(), 'run_id'),
      variant_validation_id: IDS.variantValidation,
      sequence: 2,
    };
    assertAccepted(validationTrial, 'validation trial');
    assertRejected({ ...validationTrial, sequence: 3 }, '/sequence maximum', 'third validation trial');
  });

  it('references its parent, resource manifest and input digests', () => {
    for (const field of [
      'execution_manifest_sha256',
      'resource_manifest_sha256',
      'payment_sha256',
      'approved_decision_sha256',
    ]) {
      assertRejected(withoutField(trialManifest(), field), ' required', `missing ${field}`);
    }
    assertRejected(withField(trialManifest(), 'sequence', 5), '/sequence maximum', 'fifth trial');
    assertRejected(withField(trialManifest(), 'sequence', 0), '/sequence minimum', 'trial zero');
    assertRejected(
      withField(trialManifest(), 'transport_probe_id', IDS.transportProbe),
      ' additionalProperties',
      'probe',
    );
  });
});

describe('provider_trial_configuration (BR-RUA-025, BR-RUA-018)', () => {
  it('accepts a treatment trial, a control trial and the probe configuration', () => {
    assertAccepted(trialProviderConfiguration(), 'treatment trial');
    assertAccepted(withField(trialProviderConfiguration(), 'scenario', 'CONTROL'), 'control trial declares CONTROL');
    assertAccepted(probeProviderConfiguration(), 'probe');
  });

  it('registers one variant caller for a trial and only the probe caller for the probe', () => {
    assertRejected(
      withField(trialProviderConfiguration(), 'registered_caller_id', 'probe'),
      '/registered_caller_id enum',
      'probe caller',
    );
    assertRejected(
      withField(probeProviderConfiguration(), 'registered_caller_id', 'durable'),
      '/registered_caller_id const',
      'variant',
    );
    assertRejected(withoutField(trialProviderConfiguration(), 'trial_manifest_sha256'), ' required', 'no trial digest');
    assertRejected(
      withField(probeProviderConfiguration(), 'trial_id', IDS.trial1),
      '/trial_id false schema',
      'probe trial',
    );
  });

  it('declares the treatment for the probe, which qualifies it', () => {
    assertRejected(withField(probeProviderConfiguration(), 'scenario', 'CONTROL'), '/scenario const', 'probe control');
  });

  it('carries no approved decision and the OR-RUA-002 provider intervals', () => {
    assertRejected(
      withField(trialProviderConfiguration(), 'approved_amount_minor', FIXTURE.amount_minor),
      ' additionalProperties',
      'decision',
    );
    assertRejected(
      withField(trialProviderConfiguration(), 'safety_release_ms', 0),
      '/safety_release_ms minimum',
      'release',
    );
    assertRejected(
      withField(trialProviderConfiguration(), 'treatment_poll_interval_ms', '250'),
      '/treatment_poll_interval_ms type',
      'poll',
    );
  });
});

describe('trial_registration (BR-RUA-036, D-21)', () => {
  it('accepts a run and a variant-validation registration', () => {
    assertAccepted(trialRegistration(), 'run');
    assertAccepted(
      { ...withoutField(trialRegistration(), 'run_id'), variant_validation_id: IDS.variantValidation },
      'validation',
    );
  });

  it('names the active trial that a consumer validates messages against', () => {
    for (const field of ['variant_id', 'execution_manifest_sha256', 'trial_id', 'trial_manifest_sha256']) {
      assertRejected(withoutField(trialRegistration(), field), ' required', `missing ${field}`);
    }
    assertRejected(
      withField(trialRegistration(), 'transport_probe_id', IDS.transportProbe),
      ' additionalProperties',
      'probe',
    );
    assertRejected(withoutField(trialRegistration(), 'run_id'), ' oneOf', 'no execution identity');
  });

  it('versions every conditional registry write', () => {
    assertRejected(withField(trialRegistration(), 'registry_version', 0), '/registry_version minimum', 'zero');
    assertRejected(withField(trialRegistration(), 'variant_id', 'agent'), '/variant_id enum', 'variant');
    assertRejected(
      withPath(trialRegistration(), ['registered_at'], '2026-10-05T12:04:02Z'),
      '/registered_at pattern',
      'seconds',
    );
  });
});
