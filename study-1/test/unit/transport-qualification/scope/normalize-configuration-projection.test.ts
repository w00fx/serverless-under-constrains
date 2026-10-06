// BR-RUA-028 "normalized provider and controller configuration": a projection selects the
// policy's resource type under its construct selector and keeps only configuration values.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject } from '../../../../src/record-contract/primitives.ts';
import type { ConfigurationProjectionPolicy } from '../../../../src/record-contract/records/group-a/transport_scope_policy.ts';
import {
  constructPathMatches,
  normalizeConfigurationProjection,
  snakeCaseSegment,
} from '../../../../src/transport-qualification/scope/configuration-projection.ts';
import { cdkTemplate } from './support/scope-fixtures.ts';
import { PROTOTYPE_MEMBER_NAMES } from './support/template-samples.ts';

const FUNCTIONS = {
  projection_id: 'experiment_core__functions',
  resource_type: 'AWS::Lambda::Function',
  property_paths: ['Properties.Timeout', 'Properties.Role', 'Properties.ReservedConcurrentExecutions'],
} as const;

// The provider's role as its references name it: by stack-relative construct path, not logical id.
const PROVIDER_ROLE = '{"Fn::GetAtt":["<ExperimentCore/Provider/Role/Resource>","Arn"]}';

describe('normalizeConfigurationProjection', () => {
  it('selects only the selector construct, normalizes references and omits the value of absent paths', () => {
    const projected = normalizeConfigurationProjection(cdkTemplate({ providerTimeout: 29 }), FUNCTIONS);
    assert.deepEqual(projected, {
      ok: true,
      value: [
        // construct-path order: ExperimentCore/Controller/... sorts before ExperimentCore/Provider/...
        {
          property_values: [
            { property_path: 'Properties.Timeout', canonical_json: '30' },
            { property_path: 'Properties.Role' },
            { property_path: 'Properties.ReservedConcurrentExecutions' },
          ],
        },
        {
          property_values: [
            { property_path: 'Properties.Timeout', canonical_json: '29' },
            { property_path: 'Properties.Role', canonical_json: PROVIDER_ROLE },
            { property_path: 'Properties.ReservedConcurrentExecutions' },
          ],
        },
      ],
    });
    assert.ok(projected.ok);
    const [controller, provider] = projected.value;
    // An unset property keeps only its path: no `canonical_json` key, never a null (BR-RUA-033).
    assert.equal(Object.hasOwn(provider?.property_values[2] ?? {}, 'canonical_json'), false);
    assert.equal(Object.hasOwn(controller.property_values[1] ?? {}, 'canonical_json'), false);
  });

  it('projects a later-set property with its value, so setting it is a change', () => {
    const unset = normalizeConfigurationProjection(cdkTemplate(), FUNCTIONS);
    const set = normalizeConfigurationProjection(cdkTemplate({ providerReservedConcurrency: 0 }), FUNCTIONS);
    assert.deepEqual(set, {
      ok: true,
      value: [
        {
          property_values: [
            { property_path: 'Properties.Timeout', canonical_json: '30' },
            { property_path: 'Properties.Role' },
            { property_path: 'Properties.ReservedConcurrentExecutions' },
          ],
        },
        {
          property_values: [
            { property_path: 'Properties.Timeout', canonical_json: '30' },
            { property_path: 'Properties.Role', canonical_json: PROVIDER_ROLE },
            { property_path: 'Properties.ReservedConcurrentExecutions', canonical_json: '0' },
          ],
        },
      ],
    });
    assert.notDeepEqual(set, unset);
  });

  it('sorts the selected resources by construct path, independent of template order', () => {
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
        { property_values: [{ property_path: 'Properties.Environment' }, { property_path: 'Properties.Role' }] },
        {
          property_values: [
            {
              property_path: 'Properties.Environment',
              canonical_json:
                '{"Variables":{"SUC_EXECUTION_ID":"<uuid>","SUC_TABLE_LEDGER":{"Ref":"<ExperimentCore/Ledger/Resource>"}}}',
            },
            { property_path: 'Properties.Role', canonical_json: PROVIDER_ROLE },
          ],
        },
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
    const unset = { property_values: projection.property_paths.map((path) => ({ property_path: path })) };
    assert.deepEqual(normalizeConfigurationProjection(cdkTemplate(), projection), { ok: true, value: [unset, unset] });
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
      value: [
        {
          property_values: [
            { property_path: 'Properties.constructor', canonical_json: '{"Ref":"<ExperimentCore/Fn/Resource>"}' },
            { property_path: 'Properties.toString', canonical_json: '7' },
            { property_path: 'Properties.valueOf' },
          ],
        },
      ],
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

  it('selects by the whole projection id when it has no label separator', () => {
    const projection = {
      projection_id: 'provider_function',
      resource_type: 'AWS::Lambda::Function',
      property_paths: ['Properties.MemorySize'],
    } as const;
    assert.deepEqual(normalizeConfigurationProjection(cdkTemplate(), projection), {
      ok: true,
      value: [{ property_values: [{ property_path: 'Properties.MemorySize', canonical_json: '512' }] }],
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
