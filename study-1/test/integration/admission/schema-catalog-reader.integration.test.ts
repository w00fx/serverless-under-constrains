// The production schema-catalogue port (BR-RUA-040) over the committed catalogue and over an
// unreadable root: every record schema is copied with its record type, POSIX relative path and
// exact bytes; a root that cannot be listed fails with SCHEMA_CATALOG_UNREADABLE.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { SchemaCatalogReader } from '../../../src/admission/node/schema-catalog-reader.ts';
import { RECORD_TYPES } from '../../../src/record-contract/record-types.ts';
import { DEFAULT_SCHEMA_ROOT } from '../../../src/record-contract/schema-registry.ts';

describe('SchemaCatalogReader', () => {
  it('copies every committed record schema byte for byte', async () => {
    const catalog = await new SchemaCatalogReader().readSchemaCatalog();
    assert.ok(catalog.ok);
    assert.deepEqual(catalog.value.map((copy) => copy.record_type).sort(), [...RECORD_TYPES].sort());
    for (const copy of catalog.value) {
      assert.match(copy.relative_path, /^group-[abc]\/[a-z_]+\.schema\.json$/);
      assert.deepEqual(copy.bytes, new Uint8Array(readFileSync(join(DEFAULT_SCHEMA_ROOT, copy.relative_path))));
    }
  });

  it('lists nothing under a root without schemas (A15 then refuses the empty catalogue)', async () => {
    assert.deepEqual(await new SchemaCatalogReader('/nonexistent/schemas').readSchemaCatalog(), {
      ok: true,
      value: [],
    });
  });

  it('fails with SCHEMA_CATALOG_UNREADABLE when a listed schema cannot be read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rua-admission-schemas-'));
    try {
      mkdirSync(join(root, 'group-a', 'payment.schema.json'), { recursive: true });
      const catalog = await new SchemaCatalogReader(root).readSchemaCatalog();
      assert.ok(!catalog.ok);
      assert.equal(catalog.error.code, 'SCHEMA_CATALOG_UNREADABLE');
      assert.match(catalog.error.detail, /EISDIR/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
