// Admission's lease read against the table the environment input names (design §10.1 A8,
// BR-RUA-045): the reader opens exactly that table's lease store and returns its answer; an input
// that cannot be read, is not a valid environment_input, or whose ARN names no table is a read
// failure naming the file or the ARN, and no lease store is opened.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LeaseReadPort } from '../../../src/admission/admission-ports.ts';
import { EnvironmentLeaseReader, coordinationTableName } from '../../../src/operator-cli/environment-lease-reader.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { TABLE_ARN, environmentBytes, environmentInput } from '../../support/admission/admission-fixtures.ts';
import { MemoryInputFileReader } from './support/memory-input-file-reader.ts';

const validator = createRecordValidator();
const PATH = '/operator/environment-input.json';

// Records each table it is asked to open; answers no lease item.
class RecordingLeaseOpener {
  readonly tables: string[] = [];
  readonly open = (tableName: string): LeaseReadPort => {
    this.tables.push(tableName);
    return { read: () => Promise.resolve({ ok: true, value: undefined }) };
  };
}

function readerOver(inputs: MemoryInputFileReader, opener: RecordingLeaseOpener): EnvironmentLeaseReader {
  return new EnvironmentLeaseReader({ inputs, environmentPath: PATH, validator, openLease: opener.open });
}

describe('EnvironmentLeaseReader', () => {
  it('reads the lease of the table the environment input names', async () => {
    const opener = new RecordingLeaseOpener();
    const read = await readerOver(new MemoryInputFileReader().place(PATH, environmentBytes()), opener).read();
    assert.deepEqual(read, { ok: true, value: undefined });
    assert.deepEqual(opener.tables, ['suc-study-1-coordination']);
  });

  it('opens no table when the input cannot be read or is not an environment_input', async () => {
    const cases: readonly (readonly [MemoryInputFileReader, string])[] = [
      [new MemoryInputFileReader(), `ENOENT: ENOENT: no such file or directory, open '${PATH}'`],
      [new MemoryInputFileReader().place(PATH, '{'), 'not a valid environment_input record'],
      [
        new MemoryInputFileReader().place(PATH, environmentBytes(environmentInput({ coordination_table_arn: 'x' }))),
        'not a valid environment_input record',
      ],
    ];
    for (const [inputs, problem] of cases) {
      const opener = new RecordingLeaseOpener();
      assert.deepEqual(await readerOver(inputs, opener).read(), {
        ok: false,
        error: {
          code: 'COORDINATION_TABLE_UNNAMED',
          detail: `${JSON.stringify(PATH)} names no coordination table (${problem}); expected a readable environment_input`,
        },
      });
      assert.deepEqual(opener.tables, []);
    }
  });
});

describe('coordinationTableName', () => {
  it('is the name after table/ of a DynamoDB table ARN', () => {
    assert.deepEqual(coordinationTableName(TABLE_ARN), { ok: true, value: 'suc-study-1-coordination' });
  });

  it('refuses any other ARN, quoting it', () => {
    for (const arn of [
      '',
      `${TABLE_ARN}/stream/x`,
      TABLE_ARN.replace('dynamodb', 's3'),
      'arn:aws:dynamodb:us-east-1:1:table/abc',
    ]) {
      assert.deepEqual(coordinationTableName(arn), {
        ok: false,
        error: {
          code: 'COORDINATION_TABLE_UNNAMED',
          detail: `coordination_table_arn ${JSON.stringify(arn)} names no table; expected arn:aws:dynamodb:<region>:<account>:table/<name>`,
        },
      });
    }
  });
});
