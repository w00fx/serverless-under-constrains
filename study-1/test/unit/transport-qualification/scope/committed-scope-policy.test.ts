// The committed policy file (design §6.2 row 12) is a valid `transport_scope_policy` that
// declares the BR-RUA-028 transport scope: the provider, controller and probe-caller entry
// points (design §9.4), the shared provider-client contract and its transport dependencies as
// conservative roots, the ExperimentCore configuration, the bundling runtime properties and
// the transport packages. Oracle, reporting and orchestration features stay out of it.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { createRecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import { SCOPE_BUNDLE_RUNTIME_PROPERTIES } from '../../../../src/transport-qualification/scope/bundle-inputs.ts';
import {
  TRANSPORT_SCOPE_POLICY_PATH,
  parseTransportScopePolicy,
} from '../../../../src/transport-qualification/scope/scope-policy.ts';

const STUDY_ROOT = new URL('../../../../', import.meta.url);

function committedPolicy(): ReturnType<typeof parseTransportScopePolicy> {
  return parseTransportScopePolicy(
    readFileSync(new URL(TRANSPORT_SCOPE_POLICY_PATH, STUDY_ROOT)),
    createRecordValidator(),
  );
}

describe('committed transport-scope policy', () => {
  it('is a valid transport_scope_policy record', () => {
    const parsed = committedPolicy();
    assert.deepEqual(parsed.ok ? [] : parsed.error, []);
  });

  it('declares the three transport entry points of design §9.4', () => {
    const parsed = committedPolicy();
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value.policy.entry_points, [
      'src/refund-provider/refund-provider.handler.ts',
      'src/transport-probe-caller/transport-probe-caller.handler.ts',
      'src/treatment-controller/treatment-controller.handler.ts',
    ]);
  });

  it('roots the transport features and keeps oracle, reporting and orchestration features out', () => {
    const parsed = committedPolicy();
    assert.ok(parsed.ok);
    const roots = parsed.value.policy.source_roots;
    for (const transport of [
      'src/provider-client',
      'src/refund-provider',
      'src/treatment-controller',
      'src/transport-probe-caller',
    ]) {
      assert.ok(roots.includes(transport), `expected source root ${transport}`);
    }
    const unrelated = [
      'src/trial-oracle',
      'src/evidence-ingestion',
      'src/study-comparison',
      'src/variant-validation',
      'src/trial-execution',
      'src/execution-lifecycle',
      'src/operator-cli',
      'src/conventional-variant',
      'src/durable-variant',
      'src/transport-qualification',
    ];
    assert.deepEqual(
      roots.filter((root) => unrelated.some((feature) => root === feature || root.startsWith(`${feature}/`))),
      [],
    );
  });

  it('projects ExperimentCore configuration only and binds the absence of provisioned concurrency', () => {
    const parsed = committedPolicy();
    assert.ok(parsed.ok);
    const projections = parsed.value.policy.configuration_projections;
    assert.deepEqual(
      projections.map((projection) => projection.projection_id.split('__')[0]),
      projections.map(() => 'experiment_core'),
    );
    const versions = projections.find((projection) => projection.resource_type === 'AWS::Lambda::Version');
    assert.deepEqual(versions?.property_paths, ['Properties.FunctionName', 'Properties.ProvisionedConcurrencyConfig']);
  });

  it('projects a property naming each resource, so entries identify themselves (WP-11 review round 1)', () => {
    const parsed = committedPolicy();
    assert.ok(parsed.ok);
    assert.deepEqual(
      parsed.value.policy.configuration_projections.map((projection) => [
        projection.projection_id,
        projection.property_paths.filter((path) =>
          ['Properties.FunctionName', 'Properties.Role', 'Properties.Roles', 'Properties.TableName'].includes(path),
        ),
      ]),
      [
        ['experiment_core__functions', ['Properties.Role']],
        ['experiment_core__versions', ['Properties.FunctionName']],
        ['experiment_core__stream_mappings', ['Properties.FunctionName']],
        ['experiment_core__tables', ['Properties.TableName']],
        ['experiment_core__policies', ['Properties.Roles']],
      ],
    );
  });

  it('declares exactly the bundling runtime properties the esbuild resolver binds', () => {
    const parsed = committedPolicy();
    assert.ok(parsed.ok);
    assert.deepEqual(
      [...parsed.value.policy.runtime_properties].sort(),
      Object.keys(SCOPE_BUNDLE_RUNTIME_PROPERTIES).sort(),
    );
  });

  it('declares the transport SDK, HTTP handler, CDK and bundler packages', () => {
    const parsed = committedPolicy();
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value.policy.dependencies, [
      '@aws-sdk/client-dynamodb',
      '@aws-sdk/client-lambda',
      '@smithy/node-http-handler',
      'aws-cdk-lib',
      'esbuild',
    ]);
  });

  it('carries the digest an auditor reproduces from the committed file bytes (BR-RUA-033)', () => {
    const bytes = readFileSync(new URL(TRANSPORT_SCOPE_POLICY_PATH, STUDY_ROOT));
    const parsed = committedPolicy();
    assert.ok(parsed.ok);
    assert.equal(parsed.value.policy_sha256, createHash('sha256').update(bytes).digest('hex'));
  });
});
