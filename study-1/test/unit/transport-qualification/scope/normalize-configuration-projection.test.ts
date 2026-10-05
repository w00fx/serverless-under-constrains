// BR-RUA-028 "normalized provider and controller configuration": a projection selects the
// policy's resource type under its construct selector and keeps only configuration values.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject } from '../../../../src/record-contract/primitives.ts';
import {
  constructPathMatches,
  normalizeConfigurationProjection,
  snakeCaseSegment,
} from '../../../../src/transport-qualification/scope/configuration-projection.ts';
import { cdkTemplate } from './support/scope-fixtures.ts';

const FUNCTIONS = {
  projection_id: 'experiment_core__functions',
  resource_type: 'AWS::Lambda::Function',
  property_paths: ['Properties.Timeout', 'Properties.Role', 'Properties.ReservedConcurrentExecutions'],
} as const;

describe('normalizeConfigurationProjection', () => {
  it('selects only the selector construct, normalizes references and maps absent paths to null', () => {
    const projected = normalizeConfigurationProjection(cdkTemplate({ providerTimeout: 29 }), FUNCTIONS);
    assert.deepEqual(projected, {
      ok: true,
      value: [
        // canonical order: the controller's `"Properties.Role":null` sorts before the provider's object
        { 'Properties.Timeout': 30, 'Properties.Role': null, 'Properties.ReservedConcurrentExecutions': null },
        {
          'Properties.Timeout': 29,
          'Properties.Role': { 'Fn::GetAtt': ['<AWS::IAM::Role>', 'Arn'] },
          'Properties.ReservedConcurrentExecutions': null,
        },
      ],
    });
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
        { 'Properties.Environment': null, 'Properties.Role': null },
        {
          'Properties.Environment': {
            Variables: { SUC_EXECUTION_ID: '<uuid>', SUC_TABLE_LEDGER: { Ref: '<AWS::DynamoDB::Table>' } },
          },
          'Properties.Role': { 'Fn::GetAtt': ['<AWS::IAM::Role>', 'Arn'] },
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
