// FakeSchemaCatalog conformance (design §12.2): its committed-catalogue copies equal what the
// production `SchemaCatalogReader` reads, in the same order.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SchemaCatalogReader } from '../../../../src/admission/node/schema-catalog-reader.ts';
import { FakeSchemaCatalog } from '../../../support/admission/fake-schema-catalog.ts';

describe('FakeSchemaCatalog conforms to SchemaCatalogReader', () => {
  it('returns the same copies in the same order', async () => {
    assert.deepEqual(
      await FakeSchemaCatalog.fromCommittedCatalog().readSchemaCatalog(),
      await new SchemaCatalogReader().readSchemaCatalog(),
    );
  });

  it('fails like the reader when scripted to', async () => {
    const fake = FakeSchemaCatalog.fromCommittedCatalog();
    fake.failWith('SCHEMA_CATALOG_UNREADABLE', 'EACCES');
    assert.deepEqual(await fake.readSchemaCatalog(), {
      ok: false,
      error: { code: 'SCHEMA_CATALOG_UNREADABLE', detail: 'EACCES' },
    });
  });
});
