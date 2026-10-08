// The total mappers from AWS read outputs to admission port values (A-05, design §15.4): every
// malformed, absent, inherited or wrongly typed member becomes a `PortFailure` that names it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bootstrapStatusOf,
  callerIdentityOf,
  coordinationTableOf,
  isMissingStackError,
  unreservedConcurrencyOf,
} from '../../../src/admission/cloud-readings.ts';
import { TABLE_ARN } from '../../support/admission/admission-fixtures.ts';

const CALLER_ARN = 'arn:aws:iam::012345678901:user/operator';
const TABLE = {
  Table: {
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
  },
};
const TTL = { TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } };

describe('callerIdentityOf', () => {
  it('reads the account, the ARN and the configured Region', () => {
    assert.deepEqual(callerIdentityOf({ Account: '012345678901', Arn: CALLER_ARN }, 'us-east-1'), {
      ok: true,
      value: { account: '012345678901', arn: CALLER_ARN, region: 'us-east-1' },
    });
  });

  it('names every member when any is not a nonempty string', () => {
    for (const [output, region] of [
      [{ Account: '', Arn: CALLER_ARN }, 'us-east-1'],
      [{ Account: '012345678901' }, 'us-east-1'],
      [{ Account: '012345678901', Arn: CALLER_ARN }, undefined],
      [null, 'us-east-1'],
    ] as const) {
      const read = callerIdentityOf(output, region);
      assert.ok(!read.ok);
      assert.equal(read.error.code, 'GetCallerIdentityOutputMalformed');
      assert.match(read.error.detail, /^Account .*, Arn .* and Region .*; expected three nonempty strings$/);
    }
    const read = callerIdentityOf({ Account: 12, Arn: CALLER_ARN }, 'us-east-1');
    assert.ok(!read.ok);
    assert.equal(
      read.error.detail,
      `Account 12, Arn "${CALLER_ARN}" and Region "us-east-1"; expected three nonempty strings`,
    );
  });
});

describe('unreservedConcurrencyOf', () => {
  it('reads a nonnegative safe integer', () => {
    assert.deepEqual(unreservedConcurrencyOf({ AccountLimit: { UnreservedConcurrentExecutions: 0 } }), {
      ok: true,
      value: 0,
    });
  });

  it('refuses a negative, fractional, non-number, unsafe or missing count', () => {
    for (const value of [-1, 1.5, '10', Number.MAX_SAFE_INTEGER + 1, undefined]) {
      const read = unreservedConcurrencyOf({ AccountLimit: { UnreservedConcurrentExecutions: value } });
      assert.ok(!read.ok);
      assert.equal(read.error.code, 'GetAccountSettingsOutputMalformed');
      assert.match(read.error.detail, /^UnreservedConcurrentExecutions is .+; expected a nonnegative safe integer$/);
    }
    const missing = unreservedConcurrencyOf({});
    assert.ok(!missing.ok);
    assert.equal(missing.error.detail, 'UnreservedConcurrentExecutions is absent; expected a nonnegative safe integer');
  });
});

describe('bootstrapStatusOf', () => {
  it('reads the status of exactly one stack', () => {
    assert.deepEqual(bootstrapStatusOf({ Stacks: [{ StackStatus: 'UPDATE_COMPLETE' }] }), {
      ok: true,
      value: 'UPDATE_COMPLETE',
    });
  });

  it('refuses no stack, two stacks or a non-array', () => {
    for (const stacks of [[], [{ StackStatus: 'A' }, { StackStatus: 'B' }], 'CDKToolkit']) {
      const read = bootstrapStatusOf({ Stacks: stacks });
      assert.ok(!read.ok);
      assert.equal(read.error.code, 'DescribeStacksOutputMalformed');
      assert.match(read.error.detail, /; expected exactly one CDKToolkit stack$/);
    }
  });

  it('refuses a stack without a status', () => {
    const read = bootstrapStatusOf({ Stacks: [{ StackStatus: '' }] });
    assert.deepEqual(read, {
      ok: false,
      error: { code: 'DescribeStacksOutputMalformed', detail: 'StackStatus is ""; expected a status' },
    });
  });
});

describe('isMissingStackError', () => {
  it('recognizes only the ValidationError that says the stack does not exist', () => {
    assert.equal(isMissingStackError('ValidationError', 'Stack with id CDKToolkit does not exist'), true);
    assert.equal(isMissingStackError('ValidationError', 'Template format error'), false);
    assert.equal(isMissingStackError('AccessDenied', 'Stack with id CDKToolkit does not exist'), false);
  });
});

describe('coordinationTableOf', () => {
  it('reads the table, its typed keys, deletion protection and TTL status', () => {
    assert.deepEqual(coordinationTableOf(TABLE, TTL), {
      ok: true,
      value: {
        table_arn: TABLE_ARN,
        table_status: 'ACTIVE',
        key_schema: [
          { attribute_name: 'pk', key_type: 'HASH', attribute_type: 'S' },
          { attribute_name: 'sk', key_type: 'RANGE', attribute_type: 'S' },
        ],
        deletion_protection_enabled: true,
        time_to_live_status: 'DISABLED',
      },
    });
  });

  it('leaves a key untyped when no usable definition names it', () => {
    const table = {
      Table: {
        ...TABLE.Table,
        AttributeDefinitions: [{ AttributeName: 'pk' }, { AttributeName: 'sk', AttributeType: 'S' }],
        DeletionProtectionEnabled: 'true',
      },
    };
    const read = coordinationTableOf(table, TTL);
    assert.ok(read.ok);
    assert.deepEqual(read.value.key_schema, [
      { attribute_name: 'pk', key_type: 'HASH' },
      { attribute_name: 'sk', key_type: 'RANGE', attribute_type: 'S' },
    ]);
    assert.equal(read.value.deletion_protection_enabled, false);
    const undefinedTypes = coordinationTableOf({ Table: { ...TABLE.Table, AttributeDefinitions: 'pk' } }, TTL);
    assert.ok(undefinedTypes.ok);
    assert.deepEqual(undefinedTypes.value.key_schema, [
      { attribute_name: 'pk', key_type: 'HASH' },
      { attribute_name: 'sk', key_type: 'RANGE' },
    ]);
  });

  it('names the four members when any is missing or malformed', () => {
    const malformed = [
      [{ Table: { ...TABLE.Table, TableArn: 7 } }, TTL],
      [{ Table: { ...TABLE.Table, TableStatus: '' } }, TTL],
      [{ Table: { ...TABLE.Table, KeySchema: 'pk' } }, TTL],
      [{ Table: { ...TABLE.Table, KeySchema: [{ AttributeName: 'pk' }] } }, TTL],
      [{ Table: { ...TABLE.Table, KeySchema: [{ KeyType: 'HASH' }] } }, TTL],
      [TABLE, { TimeToLiveDescription: {} }],
      [undefined, undefined],
    ] as const;
    for (const [table, ttl] of malformed) {
      const read = coordinationTableOf(table, ttl);
      assert.ok(!read.ok);
      assert.equal(read.error.code, 'DescribeTableOutputMalformed');
      assert.match(
        read.error.detail,
        /^TableArn .*, TableStatus .*, KeySchema .* and TimeToLiveStatus .*; expected all four$/,
      );
    }
    const read = coordinationTableOf(TABLE, { TimeToLiveDescription: { TimeToLiveStatus: 3 } });
    assert.ok(!read.ok);
    assert.match(read.error.detail, / and TimeToLiveStatus 3; expected all four$/);
  });
});
