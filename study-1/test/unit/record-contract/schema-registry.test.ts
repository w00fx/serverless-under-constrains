// Schema discovery and record validation (AC-RUA-046). Ordering and failure paths run on the
// named in-memory filesystem fake; the fixture catalogue on disk proves the node adapter.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import {
  DEFAULT_SCHEMA_ROOT,
  NODE_SCHEMA_FILE_SYSTEM,
  createRecordValidator,
  listSchemaFiles,
} from '../../../src/record-contract/schema-registry.ts';
import { InMemorySchemaFileSystem } from '../../support/kernel/in-memory-schema-file-system.ts';
import { FIXTURE_CATALOGUE_ROOT, SHARED_DEFS_PATH, samplePayment } from '../../support/kernel/schema-fixtures.ts';

const ROOT = '/catalogue';
const DEFS_BYTES = readFileSync(SHARED_DEFS_PATH);
const PAYMENT_SCHEMA = readFileSync(join(FIXTURE_CATALOGUE_ROOT, 'group-a/payment.schema.json'), 'utf8');

function minimalSchema(recordType: string): string {
  return JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://rua.serverless-under-constraints.invalid/schemas/${recordType}.schema.json`,
    type: 'object',
    properties: { schema_version: { const: 1 }, record_type: { const: recordType } },
    required: ['schema_version', 'record_type'],
    additionalProperties: false,
  });
}

function catalogueWithPayment(paymentSchema: string = PAYMENT_SCHEMA): InMemorySchemaFileSystem {
  return new InMemorySchemaFileSystem()
    .writeFile(`${ROOT}/_defs.schema.json`, DEFS_BYTES)
    .writeFile(`${ROOT}/group-a/payment.schema.json`, paymentSchema);
}

describe('listSchemaFiles', () => {
  it('lists schemas group by group in name order whatever order the filesystem returns', () => {
    const fileSystem = new InMemorySchemaFileSystem()
      .writeFile(`${ROOT}/group-c/oracle_result.schema.json`, minimalSchema('oracle_result'))
      .writeFile(`${ROOT}/group-c/cli_result.schema.json`, minimalSchema('cli_result'))
      .writeFile(`${ROOT}/group-a/payment.schema.json`, 'payment bytes')
      .writeFile(`${ROOT}/group-a/approved_decision.schema.json`, minimalSchema('approved_decision'))
      .writeFile(`${ROOT}/group-a/.DS_Store`, 'finder');
    const files = listSchemaFiles({ schemaRoot: ROOT, fileSystem });
    assert.deepEqual(
      files.map((file) => file.relative_path),
      [
        'group-a/approved_decision.schema.json',
        'group-a/payment.schema.json',
        'group-c/cli_result.schema.json',
        'group-c/oracle_result.schema.json',
      ],
    );
    assert.deepEqual(files[1], {
      record_type: 'payment',
      relative_path: 'group-a/payment.schema.json',
      sha256: sha256Hex(new TextEncoder().encode('payment bytes')),
    });
  });

  it('refuses a file that is not a schema of its group', () => {
    const cases: readonly [string, string][] = [
      [
        'group-a/notes.txt',
        'unexpected file /catalogue/group-a/notes.txt; expected <record_type>.schema.json for a group-a record type',
      ],
      [
        'group-a/oracle_result.schema.json',
        'unexpected file /catalogue/group-a/oracle_result.schema.json; expected <record_type>.schema.json for a group-a record type',
      ],
      [
        'group-b/Payment.schema.json',
        'unexpected file /catalogue/group-b/Payment.schema.json; expected <record_type>.schema.json for a group-b record type',
      ],
      [
        'group-c/cli_result.schema.jsonx',
        'unexpected file /catalogue/group-c/cli_result.schema.jsonx; expected <record_type>.schema.json for a group-c record type',
      ],
      [
        'group-c/xcli_result.schema.json',
        'unexpected file /catalogue/group-c/xcli_result.schema.json; expected <record_type>.schema.json for a group-c record type',
      ],
    ];
    for (const [path, message] of cases) {
      const fileSystem = new InMemorySchemaFileSystem().writeFile(`${ROOT}/${path}`, '{}');
      assert.throws(() => listSchemaFiles({ schemaRoot: ROOT, fileSystem }), { message });
    }
  });

  it('refuses a schema that disappears between listing and reading', () => {
    const fileSystem = catalogueWithPayment().forgetContents(`${ROOT}/group-a/payment.schema.json`);
    assert.throws(() => listSchemaFiles({ schemaRoot: ROOT, fileSystem }), {
      message:
        'schema file /catalogue/group-a/payment.schema.json was listed but cannot be read; expected a stable catalogue',
    });
  });

  it('reads the fixture catalogue through the node filesystem, ignoring dotfiles', () => {
    const files = listSchemaFiles({ schemaRoot: FIXTURE_CATALOGUE_ROOT });
    assert.deepEqual(
      files.map((file) => file.relative_path),
      ['group-a/payment.schema.json', 'group-b/dispatch_started.schema.json', 'group-c/oracle_result.schema.json'],
    );
    assert.equal(
      files[0]?.sha256,
      sha256Hex(readFileSync(join(FIXTURE_CATALOGUE_ROOT, 'group-a/payment.schema.json'))),
    );
  });

  it('defaults to the committed catalogue, listing only catalogued names', () => {
    for (const file of listSchemaFiles()) {
      assert.match(file.relative_path, new RegExp(`^group-[abc]/${file.record_type}\\.schema\\.json$`));
    }
    assert.equal(DEFAULT_SCHEMA_ROOT.endsWith('/src/record-contract/schemas/'), true);
  });

  it('reports absent paths through the node adapter as undefined', () => {
    assert.equal(NODE_SCHEMA_FILE_SYSTEM.listDirectory(join(FIXTURE_CATALOGUE_ROOT, 'group-z')), undefined);
    assert.equal(NODE_SCHEMA_FILE_SYSTEM.readFile(join(FIXTURE_CATALOGUE_ROOT, 'missing.json')), undefined);
  });
});

describe('createRecordValidator', () => {
  it('accepts a record that satisfies its schema and returns it', () => {
    const validator = createRecordValidator({ schemaRoot: ROOT, fileSystem: catalogueWithPayment() });
    const record = samplePayment();
    assert.deepEqual(validator.validate(record), { valid: true, record });
  });

  it('reports every schema violation with its instance path', () => {
    const validator = createRecordValidator({ schemaRoot: ROOT, fileSystem: catalogueWithPayment() });
    const checked = validator.validate({ ...samplePayment(), captured_amount_minor: 0, extra: true });
    assert.equal(checked.valid, false);
    assert.equal(checked.record_type, 'payment');
    const violations = checked.violations;
    assert.deepEqual(
      violations.map((violation) => [violation.instance_path, violation.keyword]),
      [
        ['', 'additionalProperties'],
        ['/captured_amount_minor', 'minimum'],
      ],
    );
    assert.match(violations[1]?.detail ?? '', /^must be >= 1 \(params \{"comparison":">=","limit":1\}\)$/);
  });

  it('rejects a value that is not a JSON object without loading any schema', () => {
    const fileSystem = catalogueWithPayment();
    const validator = createRecordValidator({ schemaRoot: ROOT, fileSystem });
    assert.deepEqual(validator.validate([1]), {
      valid: false,
      violations: [{ instance_path: '', keyword: 'type', detail: 'got [1]; expected a JSON object record' }],
    });
    assert.deepEqual(fileSystem.readPaths(), []);
  });

  it('rejects an uncatalogued or absent record_type', () => {
    const validator = createRecordValidator({ schemaRoot: ROOT, fileSystem: catalogueWithPayment() });
    assert.deepEqual(validator.validate({ record_type: 'refund' }), {
      valid: false,
      record_type: 'refund',
      violations: [
        {
          instance_path: '/record_type',
          keyword: 'record_type',
          detail: 'record_type "refund" is not catalogued; expected one of RECORD_TYPES',
        },
      ],
    });
    assert.deepEqual(validator.validate({ schema_version: 1 }), {
      valid: false,
      violations: [
        {
          instance_path: '/record_type',
          keyword: 'record_type',
          detail: 'record_type absent is not catalogued; expected one of RECORD_TYPES',
        },
      ],
    });
    assert.deepEqual(validator.validate({ record_type: 7 }), {
      valid: false,
      violations: [
        {
          instance_path: '/record_type',
          keyword: 'record_type',
          detail: 'record_type 7 is not catalogued; expected one of RECORD_TYPES',
        },
      ],
    });
  });

  it('rejects a catalogued type whose schema does not exist yet', () => {
    const validator = createRecordValidator({ schemaRoot: ROOT, fileSystem: catalogueWithPayment() });
    assert.deepEqual(validator.validate({ schema_version: 1, record_type: 'cli_result' }), {
      valid: false,
      record_type: 'cli_result',
      violations: [
        {
          instance_path: '',
          keyword: 'schema',
          detail: 'no schema at /catalogue/group-c/cli_result.schema.json; expected the catalogue to define it',
        },
      ],
    });
  });

  it('loads the shared definitions once and compiles each schema once, on first use', () => {
    const fileSystem = catalogueWithPayment();
    const validator = createRecordValidator({ schemaRoot: ROOT, fileSystem });
    assert.deepEqual(fileSystem.readPaths(), []);
    validator.validate(samplePayment());
    validator.validate(samplePayment());
    validator.validate({ schema_version: 1, record_type: 'cli_result' });
    validator.validate({ schema_version: 1, record_type: 'cli_result' });
    assert.deepEqual(fileSystem.readPaths(), [
      '/catalogue/_defs.schema.json',
      '/catalogue/group-a/payment.schema.json',
      '/catalogue/group-c/cli_result.schema.json',
    ]);
  });

  it('honours an explicit shared-definitions path', () => {
    const fileSystem = new InMemorySchemaFileSystem()
      .writeFile('/shared/defs.json', DEFS_BYTES)
      .writeFile(`${ROOT}/group-a/payment.schema.json`, PAYMENT_SCHEMA);
    const validator = createRecordValidator({ schemaRoot: ROOT, defsPath: '/shared/defs.json', fileSystem });
    assert.equal(validator.validate(samplePayment()).valid, true);
  });

  it('fails loudly on a broken catalogue, naming the file and the expected shape', () => {
    const payment = samplePayment();
    const noDefs = new InMemorySchemaFileSystem().writeFile(`${ROOT}/group-a/payment.schema.json`, PAYMENT_SCHEMA);
    assert.throws(() => createRecordValidator({ schemaRoot: ROOT, fileSystem: noDefs }).validate(payment), {
      message: 'shared definitions /catalogue/_defs.schema.json do not exist; expected _defs.schema.json',
    });
    assert.throws(
      () => createRecordValidator({ schemaRoot: ROOT, fileSystem: catalogueWithPayment('{"type":') }).validate(payment),
      {
        message:
          /^schema file \/catalogue\/group-a\/payment\.schema\.json is not a JSON document \(\{"kind":"invalid_json","detail":".+"\}\); expected a JSON Schema object$/,
      },
    );
    assert.throws(
      () => createRecordValidator({ schemaRoot: ROOT, fileSystem: catalogueWithPayment('[]') }).validate(payment),
      {
        message: 'schema file /catalogue/group-a/payment.schema.json holds []; expected a JSON Schema object',
      },
    );
    const camel = PAYMENT_SCHEMA.replace('"payment_id"', '"paymentId"');
    assert.throws(
      () => createRecordValidator({ schemaRoot: ROOT, fileSystem: catalogueWithPayment(camel) }).validate(payment),
      {
        message:
          'schema /catalogue/group-a/payment.schema.json breaks the catalogue conventions: property "paymentId" at /properties is not snake_case (^[a-z][a-z0-9_]*$)',
      },
    );
  });

  it('validates against a requested type, refusing a different declared type', () => {
    const validator = createRecordValidator({ schemaRoot: ROOT, fileSystem: catalogueWithPayment() });
    assert.equal(validator.validateAs('payment', samplePayment()).valid, true);
    assert.deepEqual(validator.validateAs('cli_result', samplePayment()), {
      valid: false,
      record_type: 'payment',
      violations: [
        { instance_path: '/record_type', keyword: 'const', detail: 'record_type is "payment"; expected "cli_result"' },
      ],
    });
    assert.deepEqual(validator.validateAs('payment', { record_type: 3 }), {
      valid: false,
      violations: [{ instance_path: '/record_type', keyword: 'const', detail: 'record_type is 3; expected "payment"' }],
    });
    const withoutType: JsonObject = { schema_version: 1 };
    const absent = validator.validateAs('payment', withoutType);
    assert.equal(!absent.valid && absent.violations[0]?.keyword, 'record_type');
    const notObject = validator.validateAs('payment', 'payment');
    assert.equal(!notObject.valid && notObject.violations[0]?.keyword, 'type');
  });

  it('defaults to the committed catalogue root', () => {
    assert.equal(createRecordValidator().validate(null).valid, false);
  });
});
