// AC-RUA-046 (group A) record contracts of the qualification scope (BR-RUA-028): the committed
// policy and the frozen, recomputable snapshot, including the warm-up policy (addendum §2).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { serializeRecordFile } from '../../../../src/record-contract/canonical-json.ts';
import type { StudyRecord } from '../../../../src/record-contract/records/index.ts';
import { transportScopePolicy, transportScopeSnapshot } from './support/admission-examples.ts';
import { IDS } from './support/sample-values.ts';
import { pointerOf as pointer, withValueAt } from '../group-b/support/json-paths.ts';
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
      withPath(transportScopeSnapshot(), ['runtime_properties', 'memory_size_mb'], 9007199254740992),
      '/runtime_properties/memory_size_mb anyOf',
      'unsafe integer',
    );
    assertAccepted(
      withPath(transportScopeSnapshot(), ['runtime_properties', 'memory_size_mb'], -9007199254740991),
      'smallest safe integer',
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

  it('carries each projected CloudFormation value as canonical JSON text under a snake_case member (BR-RUA-033)', () => {
    const resource = ['configuration_projections', 1, 'resources', 0] as const;
    const timeout = [...resource, 'property_values', 0] as const;
    // The canonical snapshot leaves FilterCriteria unset: the entry keeps only its path.
    assert.deepEqual(transportScopeSnapshot().configuration_projections[0].resources[0].property_values[2], {
      property_path: 'Properties.FilterCriteria',
    });
    assertAccepted(transportScopeSnapshot(), 'set and unset properties');
    // An object keyed by CloudFormation names, as an earlier projection format wrote it, is refused.
    assertRejected(
      withValueAt(
        asJson(transportScopeSnapshot()),
        ['configuration_projections', 1, 'values'],
        [{ 'Properties.Timeout': 30 }],
      ),
      '/configuration_projections/1 additionalProperties',
      'CloudFormation-keyed values',
    );
    assertRejected(
      withPath(transportScopeSnapshot(), [...timeout, 'canonical_json'], 30),
      `${pointer([...timeout, 'canonical_json'])} type`,
      'raw JSON number',
    );
    assertRejected(
      withPath(transportScopeSnapshot(), [...timeout, 'canonical_json'], null),
      `${pointer([...timeout, 'canonical_json'])} type`,
      'null instead of omitted',
    );
    assertRejected(
      withPath(transportScopeSnapshot(), [...timeout, 'canonical_json'], ''),
      `${pointer([...timeout, 'canonical_json'])} minLength`,
      'empty text',
    );
    assertRejected(
      withPath(transportScopeSnapshot(), [...timeout, 'property_path'], 'Properties..Timeout'),
      `${pointer([...timeout, 'property_path'])} pattern`,
      'path',
    );
    assertRejected(
      withValueAt(asJson(transportScopeSnapshot()), [...timeout, 'Timeout'], 30),
      `${pointer(timeout)} additionalProperties`,
      'CloudFormation member name',
    );
    assertRejected(
      withPath(transportScopeSnapshot(), [...resource, 'property_values'], []),
      `${pointer([...resource, 'property_values'])} minItems`,
      'resource without properties',
    );
    assertRejected(
      withPath(transportScopeSnapshot(), ['configuration_projections', 1, 'resources'], []),
      '/configuration_projections/1/resources minItems',
      'projection without resources',
    );
    // Two resources with the same configuration are two equal entries.
    const twin = transportScopeSnapshot().configuration_projections[1]?.resources[0];
    assertAccepted(
      withPath(transportScopeSnapshot(), ['configuration_projections', 1, 'resources'], [twin, twin]),
      'equal resources',
    );
    const timeoutEntry = transportScopeSnapshot().configuration_projections[1]?.resources[0]?.property_values[0];
    assertRejected(
      withPath(transportScopeSnapshot(), [...resource, 'property_values'], [timeoutEntry, timeoutEntry]),
      `${pointer([...resource, 'property_values'])} uniqueItems`,
      'one property listed twice',
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
