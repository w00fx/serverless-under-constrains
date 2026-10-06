// Totality of the scope boundaries on untrusted input (Owner amendment A-05; WP-11 review
// round 1, verify/r1/deep-nesting.log, deep-recompute.log, non-finite.log): the template, the
// policy and the lockfile each take 100,000-level nesting, non-finite numbers and inherited
// member names, and every Result-returning API answers with a value or a reason, never a throw
// or a rejected promise. Error details stay bounded however large the offending value is.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalJson } from '../../../../src/record-contract/canonical-json.ts';
import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import { listTemplateResources } from '../../../../src/transport-qualification/scope/cfn-template.ts';
import { normalizeCfnValue } from '../../../../src/transport-qualification/scope/cfn-value-normalization.ts';
import { normalizeConfigurationProjection } from '../../../../src/transport-qualification/scope/configuration-projection.ts';
import { PACKAGE_LOCK_PATH, parsePackageLock } from '../../../../src/transport-qualification/scope/package-lock.ts';
import {
  parseTransportScopePolicy,
  TRANSPORT_SCOPE_POLICY_PATH,
} from '../../../../src/transport-qualification/scope/scope-policy.ts';
import { recomputeScopeSnapshot } from '../../../../src/transport-qualification/scope/scope-recomputation.ts';
import { computeScopeSnapshot } from '../../../../src/transport-qualification/scope/scope-snapshot.ts';
import { FixedBundleInputResolver } from './support/fixed-bundle-input-resolver.ts';
import { MemoryCommittedSourceReader } from './support/memory-committed-source-reader.ts';
import { MemoryInstalledPackageReader } from './support/memory-installed-package-reader.ts';
import {
  SAMPLE_BUNDLES,
  SAMPLE_COMMITTED_FILES,
  SAMPLE_INSTALLED_VERSIONS,
  SAMPLE_LOCK_BYTES,
  SAMPLE_RUNTIME,
  SAMPLE_TIMING,
  cdkTemplate,
  policyBytes,
  sampleSnapshotInput,
} from './support/scope-fixtures.ts';

const DEPTH = 100_000;
/** Generous bound on a reason detail: the kernel quotes at most 200 characters of a value. */
const DETAIL_BOUND = 600;
const encoder = new TextEncoder();
const validator = createRecordValidator();

function nestedArray(depth: number, leaf: JsonValue): JsonValue {
  let value = leaf;
  for (let level = 0; level < depth; level += 1) {
    value = [value];
  }
  return value;
}

function nestedObject(depth: number, leaf: JsonValue): JsonValue {
  let value = leaf;
  for (let level = 0; level < depth; level += 1) {
    value = { Nested: value };
  }
  return value;
}

/** The sample template with the provider's Timeout replaced by `timeout`. */
function templateWithProviderTimeout(timeout: JsonValue): JsonObject {
  const template = cdkTemplate();
  const resources = template['Resources'] as Record<string, Record<string, JsonValue>>;
  const provider = resources['ExperimentCoreProviderFunctionA1B2C3D4'];
  assert.ok(provider !== undefined, 'the sample template has a provider function');
  provider['Properties'] = { ...(provider['Properties'] as JsonObject), Timeout: timeout };
  return template;
}

const TIMEOUT_PROJECTION = {
  projection_id: 'experiment_core__functions',
  resource_type: 'AWS::Lambda::Function',
  property_paths: ['Properties.Timeout'],
} as const;

const NON_FINITE_DETAIL =
  'template Resources.ExperimentCoreProviderFunctionA1B2C3D4.Properties.Timeout holds a value JSON cannot represent ' +
  'exactly, such as a non-finite number; expected finite JSON values only';

describe('template boundary totality (A-05)', () => {
  it('normalizes values nested 100,000 levels deep without a RangeError', () => {
    assert.equal(
      canonicalJson(normalizeCfnValue(nestedArray(DEPTH, 'suc1-3f1c2a9e-x'), new Map())),
      canonicalJson(nestedArray(DEPTH, 'suc1-<p>-x')),
    );
    assert.equal(
      canonicalJson(normalizeCfnValue(nestedObject(DEPTH, { Ref: 'Q' }), new Map([['Q', 'Core/Q/Resource']]))),
      canonicalJson(nestedObject(DEPTH, { Ref: '<Core/Q/Resource>' })),
    );
  });

  it('projects a selected value nested 100,000 levels deep', () => {
    const projected = normalizeConfigurationProjection(
      templateWithProviderTimeout(nestedObject(DEPTH, 30)),
      TIMEOUT_PROJECTION,
    );
    assert.ok(projected.ok);
    assert.equal(projected.value[1]?.property_values[0].canonical_json, canonicalJson(nestedObject(DEPTH, 30)));
  });

  it('refuses a malformed resource nested 100,000 levels deep with a bounded detail', () => {
    const refused = listTemplateResources({ Resources: { Deep: nestedArray(DEPTH, 1) } });
    assert.ok(!refused.ok);
    assert.equal(refused.error.code, 'TEMPLATE_INVALID');
    assert.match(
      refused.error.detail,
      /^template Resources\.Deep is array \[\[\[.*…\[truncated\]; expected an object with a string Type$/,
    );
    assert.ok(refused.error.detail.length < DETAIL_BOUND, `${String(refused.error.detail.length)} characters`);
    const huge = listTemplateResources({ Resources: { Huge: 'x'.repeat(2_000_000) } });
    assert.ok(!huge.ok && huge.error.detail.length < DETAIL_BOUND);
  });

  it('refuses a non-finite number parsed by JSON.parse (1e400) instead of throwing', () => {
    const parsed = JSON.parse(
      JSON.stringify(templateWithProviderTimeout(0)).replace('"Timeout":0', '"Timeout":1e400'),
    ) as JsonObject;
    assert.deepEqual(normalizeConfigurationProjection(parsed, TIMEOUT_PROJECTION), {
      ok: false,
      error: { code: 'TEMPLATE_INVALID', subject: 'BR-RUA-028', detail: NON_FINITE_DETAIL },
    });
    for (const timeout of [-Infinity, nestedObject(3, [Number.NaN])]) {
      const refused = normalizeConfigurationProjection(templateWithProviderTimeout(timeout), TIMEOUT_PROJECTION);
      assert.deepEqual(refused.ok ? undefined : refused.error.detail, NON_FINITE_DETAIL);
    }
  });

  it('keeps computeScopeSnapshot total over deep and non-finite templates', () => {
    assert.equal(
      computeScopeSnapshot(sampleSnapshotInput({ template: templateWithProviderTimeout(nestedObject(DEPTH, 1)) })).ok,
      true,
    );
    const refused = computeScopeSnapshot(sampleSnapshotInput({ template: templateWithProviderTimeout(Infinity) }));
    assert.deepEqual(refused.ok ? [] : refused.error.map((reason) => reason.code), ['TEMPLATE_INVALID']);
  });

  it('keeps recomputeScopeSnapshot resolved over deep and non-finite templates (regression: verify/r1/deep-recompute.log)', async () => {
    const ports = {
      sources: new MemoryCommittedSourceReader({
        ...SAMPLE_COMMITTED_FILES,
        [TRANSPORT_SCOPE_POLICY_PATH]: policyBytes(),
        [PACKAGE_LOCK_PATH]: SAMPLE_LOCK_BYTES,
      }),
      bundles: new FixedBundleInputResolver(SAMPLE_BUNDLES),
      installed: new MemoryInstalledPackageReader(SAMPLE_INSTALLED_VERSIONS),
      validator,
    };
    const environment = {
      runtime: SAMPLE_RUNTIME,
      timing: SAMPLE_TIMING,
      provider_warmup: { invocations_per_trial: 1 },
    } as const;
    const deep = await recomputeScopeSnapshot(
      { ...environment, template: templateWithProviderTimeout(nestedObject(DEPTH, 1)) },
      ports,
    );
    assert.equal(deep.ok, true);
    const nonFinite = await recomputeScopeSnapshot(
      { ...environment, template: templateWithProviderTimeout(Infinity) },
      ports,
    );
    assert.deepEqual(nonFinite.ok ? [] : nonFinite.error.map((reason) => reason.detail), [NON_FINITE_DETAIL]);
  });
});

describe('admission environment totality (A-05)', () => {
  it('refuses non-finite runtime and timing values instead of binding them', () => {
    const refused = computeScopeSnapshot(
      sampleSnapshotInput({
        runtime: { ...SAMPLE_RUNTIME, bundle_target: Infinity },
        timing: { ...SAMPLE_TIMING, provider_client_deadline_ms: Number.NaN },
      }),
    );
    assert.deepEqual(refused.ok ? [] : refused.error.map((reason) => reason.detail), [
      'runtime property bundle_target is Infinity; expected a safe integer',
      'timing value provider_client_deadline_ms is NaN; expected a positive safe integer of milliseconds',
    ]);
  });
});

describe('policy boundary totality (A-05)', () => {
  it('refuses a policy document nested 100,000 levels deep with bounded details', () => {
    const refused = parseTransportScopePolicy(encoder.encode(`${'['.repeat(DEPTH)}1${']'.repeat(DEPTH)}`), validator);
    assert.ok(!refused.ok);
    assert.deepEqual([...new Set(refused.error.map((reason) => reason.code))], ['SCOPE_POLICY_INVALID']);
    assert.ok(refused.error.every((reason) => reason.detail.length < DETAIL_BOUND));
  });

  it('refuses a non-finite number as unreadable bytes', () => {
    const refused = parseTransportScopePolicy(encoder.encode('{"schema_version":1e400}'), validator);
    assert.ok(!refused.ok);
    assert.deepEqual(
      refused.error.map((reason) => reason.code),
      ['SCOPE_POLICY_UNREADABLE'],
    );
    assert.match(refused.error[0]?.detail ?? '', /; expected one JSON document$/);
  });

  it('refuses inherited member names as undeclared policy members', () => {
    const text = new TextDecoder().decode(policyBytes()).replace('{', '{"constructor":1,"__proto__":{"toString":2},');
    const refused = parseTransportScopePolicy(encoder.encode(text), validator);
    assert.ok(!refused.ok);
    assert.deepEqual(
      refused.error.map((reason) => [reason.code, reason.detail.includes('additionalProperties')]),
      [
        ['SCOPE_POLICY_INVALID', true],
        ['SCOPE_POLICY_INVALID', true],
      ],
    );
  });
});

describe('lockfile boundary totality (A-05)', () => {
  it('refuses a lockfile version nested 100,000 levels deep with a bounded detail', () => {
    const refused = parsePackageLock(
      encoder.encode(`{"lockfileVersion":${'['.repeat(DEPTH)}3${']'.repeat(DEPTH)},"packages":{}}`),
    );
    assert.ok(!refused.ok);
    assert.match(
      refused.error.detail,
      /^package-lock\.json has lockfileVersion array \[\[\[.*…\[truncated\]; expected 2 or 3$/,
    );
    assert.ok(refused.error.detail.length < DETAIL_BOUND);
  });

  it('refuses a non-finite number as a document that is not JSON', () => {
    assert.deepEqual(parsePackageLock(encoder.encode('{"lockfileVersion":1e400,"packages":{}}')), {
      ok: false,
      error: {
        code: 'LOCKFILE_INVALID',
        subject: 'BR-RUA-028',
        detail: 'package-lock.json is not one JSON document (invalid_json)',
      },
    });
  });

  it('reads inherited member names as plain install paths and entry members', () => {
    const parsed = parsePackageLock(
      encoder.encode(
        '{"lockfileVersion":3,"packages":{"__proto__":{"version":"1.0.0"},"constructor":{"version":"2.0.0"},' +
          '"node_modules/x":{"toString":"y","valueOf":{"version":"9"}}}}',
      ),
    );
    assert.ok(parsed.ok);
    assert.deepEqual(
      [...parsed.value.packages.values()].map((entry) => [entry.install_path, entry.name, entry.version]),
      [
        ['__proto__', '__proto__', '1.0.0'],
        ['constructor', 'constructor', '2.0.0'],
        ['node_modules/x', 'x', undefined],
      ],
    );
  });
});
