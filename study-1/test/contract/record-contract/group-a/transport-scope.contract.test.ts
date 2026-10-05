// AC-RUA-046 (group A) record contracts of the qualification scope (BR-RUA-028): the committed
// policy and the frozen, recomputable snapshot, including the warm-up policy (addendum §2).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { serializeRecordFile } from '../../../../src/record-contract/canonical-json.ts';
import type { StudyRecord } from '../../../../src/record-contract/records/index.ts';
import { transportScopePolicy, transportScopeSnapshot } from './support/admission-examples.ts';
import { IDS } from './support/sample-values.ts';
import {
  asJson,
  assertAccepted,
  assertRejected,
  withField,
  withPath,
  withoutField,
} from './support/validation-assertions.ts';

describe('transport_scope_policy (BR-RUA-028)', () => {
  it('accepts the canonical policy', () => {
    assertAccepted(transportScopePolicy(), 'canonical');
    assertAccepted(withField(transportScopePolicy(), 'runtime_properties', []), 'no runtime property');
  });

  it('declares at least one entry point, source root, projection and dependency', () => {
    for (const field of ['entry_points', 'source_roots', 'configuration_projections', 'dependencies']) {
      assertRejected(withField(transportScopePolicy(), field, []), `/${field} minItems`, `empty ${field}`);
      assertRejected(withoutField(transportScopePolicy(), field), ' required', `missing ${field}`);
    }
    const [entry] = transportScopePolicy().entry_points;
    assertRejected(
      withField(transportScopePolicy(), 'entry_points', [entry, entry]),
      '/entry_points uniqueItems',
      'repeat',
    );
    assertRejected(
      withPath(transportScopePolicy(), ['entry_points', 0], '../outside.ts'),
      '/entry_points/0 format',
      'outside',
    );
    assertRejected(
      withPath(transportScopePolicy(), ['source_roots', 0], '/abs/src'),
      '/source_roots/0 format',
      'absolute',
    );
  });

  it('selects configuration by CloudFormation type and property paths', () => {
    const at = (field: string): readonly (string | number)[] => ['configuration_projections', 0, field];
    assertRejected(
      withPath(transportScopePolicy(), at('resource_type'), 'Lambda::Function'),
      '/configuration_projections/0/resource_type pattern',
      'type',
    );
    assertRejected(
      withPath(transportScopePolicy(), at('property_paths'), []),
      '/configuration_projections/0/property_paths minItems',
      'paths',
    );
    assertRejected(
      withPath(transportScopePolicy(), at('property_paths'), ['Properties..Timeout']),
      '/configuration_projections/0/property_paths/0 pattern',
      'path',
    );
    assertRejected(
      withPath(transportScopePolicy(), at('projection_id'), 'ProviderFunction'),
      '/configuration_projections/0/projection_id pattern',
      'id',
    );
  });

  it('names dependencies as npm packages and runtime properties in snake_case', () => {
    assertAccepted(withPath(transportScopePolicy(), ['dependencies', 0], 'esbuild'), 'unscoped package');
    for (const name of ['@AWS-SDK/client-lambda', 'Esbuild', '@aws-sdk/', '../local']) {
      assertRejected(withPath(transportScopePolicy(), ['dependencies', 0], name), '/dependencies/0 pattern', name);
    }
    assertRejected(
      withPath(transportScopePolicy(), ['runtime_properties', 0], 'nodeRuntime'),
      '/runtime_properties/0 pattern',
      'case',
    );
  });
});

describe('transport_scope_snapshot (BR-RUA-028)', () => {
  it('accepts the canonical snapshot', () => {
    assertAccepted(transportScopeSnapshot(), 'canonical');
  });

  it('has no execution identity or timestamp, so a recomputation is byte-identical', () => {
    assertRejected(
      withField(transportScopeSnapshot(), 'transport_probe_id', IDS.transportProbe),
      ' additionalProperties',
      'id',
    );
    assertRejected(
      withField(transportScopeSnapshot(), 'computed_at', '2026-10-05T12:00:00.000Z'),
      ' additionalProperties',
      'time',
    );
    const reordered = Object.fromEntries(Object.entries(asJson(transportScopeSnapshot())).toReversed());
    assert.deepEqual(
      serializeRecordFile(reordered as unknown as StudyRecord),
      serializeRecordFile(transportScopeSnapshot() as unknown as StudyRecord),
    );
  });

  it('pins every resolved source file and dependency', () => {
    assertRejected(withField(transportScopeSnapshot(), 'source_files', []), '/source_files minItems', 'no source');
    assertRejected(
      withPath(transportScopeSnapshot(), ['source_files', 0, 'sha256'], 'abc'),
      '/source_files/0/sha256 pattern',
      'digest',
    );
    assertRejected(
      withField(transportScopeSnapshot(), 'dependency_closure', []),
      '/dependency_closure minItems',
      'no closure',
    );
    assertRejected(
      withPath(transportScopeSnapshot(), ['dependency_closure', 0, 'version'], ''),
      '/dependency_closure/0/version pattern',
      'version',
    );
    assertRejected(withoutField(transportScopeSnapshot(), 'lockfile_sha256'), ' required', 'no lockfile digest');
    assertRejected(withoutField(transportScopeSnapshot(), 'policy_sha256'), ' required', 'no policy digest');
  });

  it('records normalized configuration, runtime values and timing values', () => {
    assertRejected(
      withField(transportScopeSnapshot(), 'configuration_projections', []),
      '/configuration_projections minItems',
      'none',
    );
    assertRejected(
      withPath(transportScopeSnapshot(), ['runtime_properties', 'node_runtime'], null),
      '/runtime_properties/node_runtime anyOf',
      'null',
    );
    assertRejected(
      withField(transportScopeSnapshot(), 'runtime_properties', { NodeRuntime: 'nodejs24.x' }),
      '/runtime_properties propertyNames',
      'key',
    );
    assertRejected(
      withPath(transportScopeSnapshot(), ['timing_values', 'provider_client_deadline_ms'], 0),
      '/timing_values/provider_client_deadline_ms minimum',
      'zero',
    );
    assertRejected(
      withPath(transportScopeSnapshot(), ['timing_values', 'treatment_poll_interval_ms'], 250.5),
      '/timing_values/treatment_poll_interval_ms type',
      'fraction',
    );
  });

  it('declares the single provider warm-up per trial (addendum §2)', () => {
    assertRejected(withoutField(transportScopeSnapshot(), 'provider_warmup'), ' required', 'missing policy');
    for (const count of [0, 2]) {
      assertRejected(
        withPath(transportScopeSnapshot(), ['provider_warmup', 'invocations_per_trial'], count),
        '/provider_warmup/invocations_per_trial const',
        String(count),
      );
    }
  });
});
