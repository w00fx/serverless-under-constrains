// BR-RUA-028 "normalized provider and controller configuration" keeps resource identity (WP-11
// review round 1, verify/spec-r1-identity.log): entries follow the stack-relative construct
// path, and a reference names the referenced resource's construct path, so swapping two
// resources' settings or retargeting a grant is a different projection, while execution-specific
// logical-id hashes still are not.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';
import type { ConfigurationProjectionPolicy } from '../../../../src/record-contract/records/group-a/transport_scope_policy.ts';
import { normalizeConfigurationProjection } from '../../../../src/transport-qualification/scope/configuration-projection.ts';

const FUNCTION_TIMEOUTS: ConfigurationProjectionPolicy = {
  projection_id: 'experiment_core__functions',
  resource_type: 'AWS::Lambda::Function',
  property_paths: ['Properties.Timeout'],
};

const POLICY_DOCUMENTS: ConfigurationProjectionPolicy = {
  projection_id: 'experiment_core__policies',
  resource_type: 'AWS::IAM::Policy',
  property_paths: ['Properties.PolicyDocument'],
};

function placed(type: string, path: string, properties: JsonObject): JsonObject {
  return { Type: type, Properties: properties, Metadata: { 'aws:cdk:path': `SucRua-run-3f1c2a9e/${path}` } };
}

/** Provider and controller functions whose timeouts are given, under hash-suffixed logical ids. */
function functionsWith(providerTimeout: number, controllerTimeout: number, hash = 'A1B2'): JsonObject {
  return {
    Resources: {
      [`ExperimentCoreProviderFunction${hash}`]: placed(
        'AWS::Lambda::Function',
        'ExperimentCore/Provider/Function/Resource',
        {
          Timeout: providerTimeout,
        },
      ),
      [`ExperimentCoreControllerFunction${hash}`]: placed(
        'AWS::Lambda::Function',
        'ExperimentCore/Controller/Function/Resource',
        { Timeout: controllerTimeout },
      ),
    },
  };
}

/** The provider's policy granting PutItem on one of two tables. */
function grantOn(table: 'Ledger' | 'CallerJournal', hash = 'A1B2'): JsonObject {
  const statement: JsonValue = {
    Action: 'dynamodb:PutItem',
    Effect: 'Allow',
    Resource: { 'Fn::GetAtt': [`ExperimentCore${table}Table${hash}`, 'Arn'] },
  };
  return {
    Resources: {
      [`ExperimentCoreLedgerTable${hash}`]: placed('AWS::DynamoDB::Table', 'ExperimentCore/LedgerTable/Resource', {}),
      [`ExperimentCoreCallerJournalTable${hash}`]: placed(
        'AWS::DynamoDB::Table',
        'ExperimentCore/CallerJournalTable/Resource',
        {},
      ),
      [`ExperimentCoreProviderRoleDefaultPolicy${hash}`]: placed(
        'AWS::IAM::Policy',
        'ExperimentCore/Provider/Role/DefaultPolicy/Resource',
        { PolicyDocument: { Statement: [statement], Version: '2012-10-17' } },
      ),
    },
  };
}

function timeouts(template: JsonObject): readonly (string | undefined)[] {
  const projected = normalizeConfigurationProjection(template, FUNCTION_TIMEOUTS);
  assert.ok(projected.ok, JSON.stringify(projected));
  return projected.value.map((resource) => resource.property_values[0].canonical_json);
}

describe('configuration projection identity', () => {
  it('orders entries by construct path, so a provider/controller swap is a different projection', () => {
    // Controller sorts before Provider: [controller, provider].
    assert.deepEqual(timeouts(functionsWith(30, 60)), ['60', '30']);
    assert.deepEqual(timeouts(functionsWith(60, 30)), ['30', '60']);
  });

  it('names a referenced table by its construct path, so a retargeted grant is a different projection', () => {
    const onLedger = normalizeConfigurationProjection(grantOn('Ledger'), POLICY_DOCUMENTS);
    const onJournal = normalizeConfigurationProjection(grantOn('CallerJournal'), POLICY_DOCUMENTS);
    const statementOn = (table: string): string =>
      '{"Statement":[{"Action":"dynamodb:PutItem","Effect":"Allow","Resource":{"Fn::GetAtt":' +
      `["<ExperimentCore/${table}/Resource>","Arn"]}}],"Version":"2012-10-17"}`;
    assert.deepEqual(onLedger, {
      ok: true,
      value: [
        {
          property_values: [{ property_path: 'Properties.PolicyDocument', canonical_json: statementOn('LedgerTable') }],
        },
      ],
    });
    assert.deepEqual(onJournal, {
      ok: true,
      value: [
        {
          property_values: [
            { property_path: 'Properties.PolicyDocument', canonical_json: statementOn('CallerJournalTable') },
          ],
        },
      ],
    });
  });

  it('ignores logical-id hashes, which vary with the execution', () => {
    assert.deepEqual(timeouts(functionsWith(30, 60, 'FFFF')), timeouts(functionsWith(30, 60, '0000')));
    assert.deepEqual(
      normalizeConfigurationProjection(grantOn('Ledger', 'FFFF'), POLICY_DOCUMENTS),
      normalizeConfigurationProjection(grantOn('Ledger', '0000'), POLICY_DOCUMENTS),
    );
  });

  it('names a referenced resource without construct-path metadata by its type', () => {
    const template = {
      Resources: {
        Fn: placed('AWS::Lambda::Function', 'ExperimentCore/Fn/Resource', { DeadLetterConfig: { Ref: 'Queue1A2B' } }),
        Queue1A2B: { Type: 'AWS::SQS::Queue' },
      },
    };
    assert.deepEqual(
      normalizeConfigurationProjection(template, {
        ...FUNCTION_TIMEOUTS,
        property_paths: ['Properties.DeadLetterConfig'],
      }),
      {
        ok: true,
        value: [
          {
            property_values: [
              { property_path: 'Properties.DeadLetterConfig', canonical_json: '{"Ref":"<AWS::SQS::Queue>"}' },
            ],
          },
        ],
      },
    );
  });

  it('orders resources that repeat one construct path by canonical form, independent of template order', () => {
    const repeated = (first: number, second: number): JsonObject => ({
      Resources: {
        A: placed('AWS::Lambda::Function', 'ExperimentCore/Fn/Resource', { Timeout: first }),
        B: placed('AWS::Lambda::Function', 'ExperimentCore/Fn/Resource', { Timeout: second }),
      },
    });
    assert.deepEqual(timeouts(repeated(2, 1)), ['1', '2']);
    assert.deepEqual(timeouts(repeated(1, 2)), ['1', '2']);
  });
});
