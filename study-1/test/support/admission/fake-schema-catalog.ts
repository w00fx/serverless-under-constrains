// FakeSchemaCatalog (design §12.2): the schema-catalogue port over in-memory copies. It emulates
// `SchemaCatalogReader`: every copy carries its record type, its POSIX path relative to the
// schema root and its exact bytes, in the catalogue's listing order. `fromCommittedCatalog()`
// reads the committed catalogue once, so the copies are the real schemas. Its conformance test
// compares that with the production reader.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { err, ok } from '../../../src/record-contract/primitives.ts';
import { DEFAULT_SCHEMA_ROOT, listSchemaFiles } from '../../../src/record-contract/schema-registry.ts';
import type {
  PortFailure,
  PortResult,
  SchemaCatalogReadPort,
  SchemaCopy,
} from '../../../src/admission/admission-ports.ts';

/**
 * The schema copies as scripted.
 *
 * @example
 * const schemas = FakeSchemaCatalog.fromCommittedCatalog();
 * await schemas.readSchemaCatalog(); // { ok: true, value: [{ record_type: …, relative_path: …, bytes }, …] }
 */
export class FakeSchemaCatalog implements SchemaCatalogReadPort {
  readonly #copies: readonly SchemaCopy[];
  #failure: PortFailure | undefined;

  constructor(copies: readonly SchemaCopy[]) {
    this.#copies = copies;
  }

  /** The committed catalogue's copies. */
  static fromCommittedCatalog(): FakeSchemaCatalog {
    return new FakeSchemaCatalog(
      listSchemaFiles({ schemaRoot: DEFAULT_SCHEMA_ROOT }).map((file) => ({
        record_type: file.record_type,
        relative_path: file.relative_path,
        bytes: new Uint8Array(readFileSync(join(DEFAULT_SCHEMA_ROOT, file.relative_path))),
      })),
    );
  }

  /** Every later read fails with this failure. */
  failWith(code: string, detail: string): void {
    this.#failure = { code, detail };
  }

  readSchemaCatalog(): PortResult<readonly SchemaCopy[]> {
    return Promise.resolve(this.#failure === undefined ? ok([...this.#copies]) : err(this.#failure));
  }
}
