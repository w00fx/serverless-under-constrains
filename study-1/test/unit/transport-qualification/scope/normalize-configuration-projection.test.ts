// BR-RUA-028 "normalized provider and controller configuration": a projection selects the
// policy's resource type under its construct selector and keeps only configuration values.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { canonicalJson } from '../../../../src/record-contract/canonical-json.ts';
import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';
import type { ConfigurationProjectionPolicy } from '../../../../src/record-contract/records/group-a/transport_scope_policy.ts';
import { createRecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import {
  constructPathMatches,
  normalizeConfigurationProjection,
  snakeCaseSegment,
} from '../../../../src/transport-qualification/scope/configuration-projection.ts';
import { fuzzParameters } from '../../../support/kernel/fuzz-parameters.ts';
import { SAMPLE_POLICY, cdkTemplate } from './support/scope-fixtures.ts';

/** Members every plain object inherits from `Object.prototype`; the policy path pattern admits them. */
const PROTOTYPE_MEMBER_NAMES = [
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
] as const;

const FUNCTIONS = {
  projection_id: 'experiment_core__functions',
  resource_type: 'AWS::Lambda::Function',
  property_paths: ['Properties.Timeout', 'Properties.Role', 'Properties.ReservedConcurrentExecutions'],
} as const;

describe('normalizeConfigurationProjection', () => {
  it('selects only the selector construct, normalizes references and omits absent paths', () => {
    const projected = normalizeConfigurationProjection(cdkTemplate({ providerTimeout: 29 }), FUNCTIONS);
    assert.deepEqual(projected, {
      ok: true,
      value: [
        // canonical order: the provider's `"Properties.Role"` sorts before the controller's `"Properties.Timeout"`
        { 'Properties.Timeout': 29, 'Properties.Role': { 'Fn::GetAtt': ['<AWS::IAM::Role>', 'Arn'] } },
        { 'Properties.Timeout': 30 },
      ],
    });
    assert.ok(projected.ok);
    const [provider, controller] = projected.value as readonly JsonObject[];
    assert.equal(Object.hasOwn(provider ?? {}, 'Properties.ReservedConcurrentExecutions'), false);
    assert.equal(Object.hasOwn(controller ?? {}, 'Properties.Role'), false);
  });

  it('projects a later-set property as a new key, so setting it is a change', () => {
    const unset = normalizeConfigurationProjection(cdkTemplate(), FUNCTIONS);
    const set = normalizeConfigurationProjection(cdkTemplate({ providerReservedConcurrency: 0 }), FUNCTIONS);
    assert.deepEqual(set, {
      ok: true,
      value: [
        {
          'Properties.Timeout': 30,
          'Properties.Role': { 'Fn::GetAtt': ['<AWS::IAM::Role>', 'Arn'] },
          'Properties.ReservedConcurrentExecutions': 0,
        },
        { 'Properties.Timeout': 30 },
      ],
    });
    assert.notDeepEqual(set, unset);
  });

  it('sorts the selected resources by canonical form, independent of template order', () => {
    const template = cdkTemplate();
    const resources = template['Resources'] as JsonObject;
    const reversed = { ...template, Resources: Object.fromEntries(Object.entries(resources).reverse()) };
    assert.deepEqual(
      normalizeConfigurationProjection(reversed, FUNCTIONS),
      normalizeConfigurationProjection(template, FUNCTIONS),
    );
  });

  it('projects the same values for different executions, stacks and logical-id hashes', () => {
    const probe = normalizeConfigurationProjection(cdkTemplate({ kind: 'probe', hash: 'AAAA1111' }), {
      ...FUNCTIONS,
      property_paths: ['Properties.Environment', 'Properties.Role'],
    });
    const run = normalizeConfigurationProjection(
      cdkTemplate({ kind: 'run', executionId: '0f0e0d0c-0b0a-4908-8706-050403020100', hash: 'BBBB2222' }),
      { ...FUNCTIONS, property_paths: ['Properties.Environment', 'Properties.Role'] },
    );
    assert.deepEqual(run, probe);
    assert.deepEqual(probe, {
      ok: true,
      value: [
        {
          'Properties.Environment': {
            Variables: { SUC_EXECUTION_ID: '<uuid>', SUC_TABLE_LEDGER: { Ref: '<AWS::DynamoDB::Table>' } },
          },
          'Properties.Role': { 'Fn::GetAtt': ['<AWS::IAM::Role>', 'Arn'] },
        },
        {},
      ],
    });
  });

  it('matches the selector on the construct path only, never on the stack name', () => {
    const projection = {
      projection_id: 'suc_rua_probe',
      resource_type: 'AWS::Lambda::Function',
      property_paths: ['Properties.Timeout'],
    } as const;
    const result = normalizeConfigurationProjection(cdkTemplate(), projection);
    assert.equal(result.ok, false);
  });

  it('refuses a projection that selects no resource', () => {
    const projection = {
      projection_id: 'experiment_core__queues',
      resource_type: 'AWS::SQS::Queue',
      property_paths: ['Properties.VisibilityTimeout'],
    } as const;
    assert.deepEqual(normalizeConfigurationProjection(cdkTemplate(), projection), {
      ok: false,
      error: {
        code: 'PROJECTION_SELECTS_NOTHING',
        subject: 'BR-RUA-028',
        detail:
          'projection experiment_core__queues selects no AWS::SQS::Queue under a construct path matching "experiment_core"; ' +
          'expected at least one resource',
      },
    });
  });

  it('refuses a malformed template', () => {
    assert.deepEqual(normalizeConfigurationProjection({}, FUNCTIONS), {
      ok: false,
      error: {
        code: 'TEMPLATE_INVALID',
        subject: 'BR-RUA-028',
        detail: 'template Resources is absent; expected an object of resources',
      },
    });
  });

  it('reads inherited member names as absent, never as functions (regression: verify/inherited-path.ts)', () => {
    const projection: ConfigurationProjectionPolicy = {
      projection_id: 'experiment_core__functions',
      resource_type: 'AWS::Lambda::Function',
      property_paths: [
        'constructor',
        ...PROTOTYPE_MEMBER_NAMES.map((name) => `Properties.${name}`),
        'Properties.Timeout.constructor',
      ],
    };
    assert.deepEqual(normalizeConfigurationProjection(cdkTemplate(), projection), { ok: true, value: [{}, {}] });
  });

  it('projects a property whose own key is an Object.prototype member name', () => {
    const template = {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: JSON.parse('{"constructor":{"Ref":"Fn"},"toString":7}') as JsonObject,
          Metadata: { 'aws:cdk:path': 'Stack/ExperimentCore/Fn/Resource' },
        },
      },
    };
    const projection: ConfigurationProjectionPolicy = {
      projection_id: 'experiment_core__functions',
      resource_type: 'AWS::Lambda::Function',
      property_paths: ['Properties.constructor', 'Properties.toString', 'Properties.valueOf'],
    };
    assert.deepEqual(normalizeConfigurationProjection(template, projection), {
      ok: true,
      value: [{ 'Properties.constructor': { Ref: '<AWS::Lambda::Function>' }, 'Properties.toString': 7 }],
    });
  });

  it('refuses a resource of the projected type without construct-path metadata', () => {
    const template = cdkTemplate();
    const resources = { ...(template['Resources'] as JsonObject) };
    resources['UnplacedFunction'] = { Type: 'AWS::Lambda::Function', Properties: { Timeout: 3 } };
    resources['NumericPathFunction'] = {
      Type: 'AWS::Lambda::Function',
      Properties: { Timeout: 3 },
      Metadata: { 'aws:cdk:path': 7 },
    };
    assert.deepEqual(normalizeConfigurationProjection({ ...template, Resources: resources }, FUNCTIONS), {
      ok: false,
      error: {
        code: 'TEMPLATE_WITHOUT_PATH_METADATA',
        subject: 'BR-RUA-028',
        detail:
          'projection experiment_core__functions: AWS::Lambda::Function resources ["UnplacedFunction","NumericPathFunction"] ' +
          'carry no string Metadata["aws:cdk:path"]; expected a template synthesized with construct path metadata ' +
          '(the cdk synth default, or context aws:cdk:enable-path-metadata=true)',
      },
    });
  });

  it('ignores missing construct-path metadata on resources of other types', () => {
    const template = cdkTemplate();
    const resources = { ...(template['Resources'] as JsonObject), Queue: { Type: 'AWS::SQS::Queue' } };
    assert.deepEqual(
      normalizeConfigurationProjection({ ...template, Resources: resources }, FUNCTIONS),
      normalizeConfigurationProjection(template, FUNCTIONS),
    );
  });

  it('is total over generated templates and schema-valid property paths (property)', () => {
    const validator = createRecordValidator();
    const segment = fc.oneof(
      fc.constantFrom(...PROTOTYPE_MEMBER_NAMES, 'Properties', 'Timeout', 'Role', 'Metadata', 'Type', 'Fn', 'Ref'),
      fc.stringMatching(/^[A-Za-z0-9]{1,6}$/),
    );
    const propertyPath = fc.array(segment, { minLength: 1, maxLength: 3 }).map((segments) => segments.join('.'));
    const keyName = fc.constantFrom(...PROTOTYPE_MEMBER_NAMES, 'Timeout', 'Role', 'Fn', 'Ref', 'Fn::GetAtt', 'Tags');
    const resource = fc.record(
      {
        Type: fc.constantFrom('AWS::Lambda::Function', 'AWS::IAM::Role', 'AWS::SQS::Queue'),
        Properties: fc.dictionary(keyName, fc.jsonValue({ maxDepth: 2 }) as fc.Arbitrary<JsonValue>, { maxKeys: 4 }),
        Metadata: fc.oneof(
          fc.record({
            'aws:cdk:path': fc.constantFrom('S/ExperimentCore/Fn/Resource', 'S/Other/Fn/Resource', 'S'),
          }),
          fc.dictionary(keyName, fc.jsonValue({ maxDepth: 1 }) as fc.Arbitrary<JsonValue>, { maxKeys: 2 }),
        ),
      },
      { requiredKeys: ['Type'] },
    );
    const template = fc.dictionary(
      fc.constantFrom('Fn', 'Role', 'Queue', 'Other', ...PROTOTYPE_MEMBER_NAMES),
      resource,
      {
        maxKeys: 4,
      },
    );
    const propertyPaths = fc
      .tuple(propertyPath, fc.uniqueArray(propertyPath, { maxLength: 3 }))
      .map(([first, rest]): ConfigurationProjectionPolicy['property_paths'] => [
        first,
        ...rest.filter((path) => path !== first),
      ]);
    const projection = fc.record({
      projection_id: fc.constantFrom('experiment_core__functions', 'other', 'fn'),
      resource_type: fc.constantFrom('AWS::Lambda::Function', 'AWS::SQS::Queue'),
      property_paths: propertyPaths,
    });
    fc.assert(
      fc.property(template, projection, (resources, generated) => {
        const policy = { ...SAMPLE_POLICY, configuration_projections: [generated] };
        assert.equal(validator.validateAs('transport_scope_policy', policy as never).valid, true);
        const projected = normalizeConfigurationProjection({ Resources: resources }, generated);
        if (projected.ok) {
          // Every projected value is JSON the canonical writer accepts (it throws on a function).
          assert.equal(typeof canonicalJson(projected.value), 'string');
        } else {
          assert.ok(
            ['PROJECTION_SELECTS_NOTHING', 'TEMPLATE_WITHOUT_PATH_METADATA'].includes(projected.error.code),
            JSON.stringify(projected.error),
          );
        }
      }),
      fuzzParameters(),
    );
  });

  it('selects by the whole projection id when it has no label separator', () => {
    const projection = {
      projection_id: 'provider_function',
      resource_type: 'AWS::Lambda::Function',
      property_paths: ['Properties.MemorySize'],
    } as const;
    assert.deepEqual(normalizeConfigurationProjection(cdkTemplate(), projection), {
      ok: true,
      value: [{ 'Properties.MemorySize': 512 }],
    });
  });
});

describe('constructPathMatches', () => {
  const path = ['ExperimentCore', 'Provider', 'Function', 'Resource'];

  it('matches any contiguous run of snake-cased segments', () => {
    assert.equal(constructPathMatches(path, 'experiment_core'), true);
    assert.equal(constructPathMatches(path, 'provider'), true);
    assert.equal(constructPathMatches(path, 'provider_function'), true);
    assert.equal(constructPathMatches(path, 'experiment_core_provider_function_resource'), true);
    assert.equal(constructPathMatches(path, 'resource'), true);
  });

  it('refuses partial segments, gaps and empty paths', () => {
    assert.equal(constructPathMatches(path, 'core_provider'), false);
    assert.equal(constructPathMatches(path, 'experiment_core_function'), false);
    assert.equal(constructPathMatches(path, 'experiment'), false);
    assert.equal(constructPathMatches(path, 'provider_function_resource_x'), false);
    assert.equal(constructPathMatches([], ''), false);
  });
});

describe('snakeCaseSegment', () => {
  it('converts construct ids to snake case', () => {
    assert.equal(snakeCaseSegment('ExperimentCore'), 'experiment_core');
    assert.equal(snakeCaseSegment('Provider'), 'provider');
    assert.equal(snakeCaseSegment('StreamESMapping'), 'stream_es_mapping');
    assert.equal(snakeCaseSegment('ESM'), 'esm');
    assert.equal(snakeCaseSegment('Table2Stream'), 'table2_stream');
    assert.equal(snakeCaseSegment('DynamoDBEventSource:Stack1Table'), 'dynamo_db_event_source_stack1_table');
    assert.equal(snakeCaseSegment('--Leading..Trailing--'), 'leading_trailing');
    assert.equal(snakeCaseSegment('already_snake'), 'already_snake');
  });
});
