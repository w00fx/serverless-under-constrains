// The production schema-catalogue port (BR-RUA-040, design §7 `admission/schemas/`): every record
// schema of the committed catalogue, listed by the kernel's `listSchemaFiles` and read as exact
// bytes, so the package keeps byte copies whose digests the manifest names.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_SCHEMA_ROOT, listSchemaFiles } from '../../record-contract/schema-registry.ts';
import type { PortResult, SchemaCatalogReadPort, SchemaCopy } from '../admission-ports.ts';

/**
 * Reads the record schemas under a schema root (default: the committed catalogue).
 *
 * @example
 * await new SchemaCatalogReader().readSchemaCatalog(); // { ok: true, value: [{ record_type: 'payment', … }, …] }
 */
export class SchemaCatalogReader implements SchemaCatalogReadPort {
  readonly #schemaRoot: string;

  constructor(schemaRoot: string = DEFAULT_SCHEMA_ROOT) {
    this.#schemaRoot = schemaRoot;
  }

  readSchemaCatalog(): PortResult<readonly SchemaCopy[]> {
    try {
      const copies = listSchemaFiles({ schemaRoot: this.#schemaRoot }).map((file) => ({
        record_type: file.record_type,
        relative_path: file.relative_path,
        bytes: new Uint8Array(readFileSync(join(this.#schemaRoot, file.relative_path))),
      }));
      return Promise.resolve({ ok: true, value: copies });
    } catch (error: unknown) {
      return Promise.resolve({ ok: false, error: { code: 'SCHEMA_CATALOG_UNREADABLE', detail: String(error) } });
    }
  }
}
