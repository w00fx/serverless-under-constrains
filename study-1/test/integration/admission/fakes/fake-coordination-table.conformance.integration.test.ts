// FakeCoordinationTable conformance (design §12.2): for the baseline table, a misconfigured one
// and a missing one, the production reader over the real DynamoDB client answers what the fake
// answers.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCoordinationTableReader } from '../../../../src/admission/aws/admission-aws-readers.ts';
import { TABLE_ARN } from '../../../support/admission/admission-fixtures.ts';
import { FakeCoordinationTable } from '../../../support/admission/fake-coordination-table.ts';
import { ScriptedAdmissionEndpoint } from '../../../support/admission/scripted-admission-endpoint.ts';

function describedTable(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    TableArn: TABLE_ARN,
    TableStatus: 'ACTIVE',
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ],
    DeletionProtectionEnabled: true,
    ...overrides,
  };
}

describe('FakeCoordinationTable conforms to the DynamoDB reader', () => {
  it('answers the same baseline description', async () => {
    const endpoint = new ScriptedAdmissionEndpoint();
    endpoint.answerCoordinationTable(describedTable() as never, { TimeToLiveStatus: 'DISABLED' });
    assert.deepEqual(
      await new FakeCoordinationTable().readCoordinationTable(TABLE_ARN),
      await createCoordinationTableReader(endpoint.clients.dynamodb).readCoordinationTable(TABLE_ARN),
    );
  });

  it('answers the same misconfigured description', async () => {
    const endpoint = new ScriptedAdmissionEndpoint();
    endpoint.answerCoordinationTable(
      describedTable({ TableStatus: 'UPDATING', DeletionProtectionEnabled: false }) as never,
      {
        TimeToLiveStatus: 'ENABLED',
      },
    );
    assert.deepEqual(
      await new FakeCoordinationTable({
        table_status: 'UPDATING',
        deletion_protection_enabled: false,
        time_to_live_status: 'ENABLED',
      }).readCoordinationTable(TABLE_ARN),
      await createCoordinationTableReader(endpoint.clients.dynamodb).readCoordinationTable(TABLE_ARN),
    );
  });

  it('fails the same way for a table that does not exist', async () => {
    const other = TABLE_ARN.replace('coordination', 'other');
    const endpoint = new ScriptedAdmissionEndpoint();
    endpoint.fail('dynamodb:DescribeTable', {
      status: 400,
      code: 'ResourceNotFoundException',
      message: `Requested resource not found: Table: ${other} not found`,
    });
    const fake = new FakeCoordinationTable();
    assert.deepEqual(
      await fake.readCoordinationTable(other),
      await createCoordinationTableReader(endpoint.clients.dynamodb).readCoordinationTable(other),
    );
    assert.deepEqual(fake.requested(), [other]);
  });
});
