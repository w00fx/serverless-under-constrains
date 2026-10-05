// Conformance of InMemorySchemaFileSystem with NODE_SCHEMA_FILE_SYSTEM over a real temporary
// directory: same names (as a set; order is filesystem-specific), same bytes, and undefined for
// absent directories and files.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { NODE_SCHEMA_FILE_SYSTEM } from '../../../../src/record-contract/schema-registry.ts';
import type { SchemaFileSystem } from '../../../../src/record-contract/schema-registry.ts';
import { InMemorySchemaFileSystem } from '../../../support/kernel/in-memory-schema-file-system.ts';

const root = mkdtempSync(join(tmpdir(), 'rua-schema-fs-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
});

const files: readonly [string, Uint8Array][] = [
  ['group-b/dispatch_started.schema.json', new TextEncoder().encode('{"b":1}')],
  ['group-b/attempt_registered.schema.json', Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d)],
  ['group-a/payment.schema.json', new Uint8Array()],
];

mkdirSync(join(root, 'group-a'));
mkdirSync(join(root, 'group-b'));
const fake = new InMemorySchemaFileSystem();
for (const [path, bytes] of files) {
  writeFileSync(join(root, path), bytes);
  fake.writeFile(join(root, path), bytes);
}

const subjects: readonly [string, SchemaFileSystem][] = [
  ['NODE_SCHEMA_FILE_SYSTEM', NODE_SCHEMA_FILE_SYSTEM],
  ['InMemorySchemaFileSystem', fake],
];

for (const [name, fileSystem] of subjects) {
  describe(`schema file system contract: ${name}`, () => {
    it('lists the entries of a directory', () => {
      assert.deepEqual(
        new Set(fileSystem.listDirectory(join(root, 'group-b'))),
        new Set(['dispatch_started.schema.json', 'attempt_registered.schema.json']),
      );
      assert.deepEqual(fileSystem.listDirectory(join(root, 'group-a')), ['payment.schema.json']);
    });

    it('returns exact bytes', () => {
      for (const [path, bytes] of files) {
        assert.deepEqual(
          Buffer.from(fileSystem.readFile(join(root, path)) ?? Uint8Array.of(0xff)),
          Buffer.from(bytes),
          path,
        );
      }
    });

    it('returns undefined for absent paths', () => {
      assert.equal(fileSystem.listDirectory(join(root, 'group-c')), undefined);
      assert.equal(fileSystem.readFile(join(root, 'group-a/missing.schema.json')), undefined);
    });
  });
}

describe('InMemorySchemaFileSystem test controls', () => {
  it('lists in write order, overwrites without duplicating, records reads and forgets contents', () => {
    const memory = new InMemorySchemaFileSystem()
      .writeFile('/r/g/b.json', 'x')
      .writeFile('/r/g/a.json', 'y')
      .writeFile('/r/g/b.json', 'z');
    assert.deepEqual(memory.listDirectory('/r/g'), ['b.json', 'a.json']);
    assert.equal(new TextDecoder().decode(memory.readFile('/r/g/b.json')), 'z');
    memory.forgetContents('/r/g/a.json');
    assert.equal(memory.readFile('/r/g/a.json'), undefined);
    assert.deepEqual(memory.listDirectory('/r/g'), ['b.json', 'a.json']);
    assert.deepEqual(memory.readPaths(), ['/r/g/b.json', '/r/g/a.json']);
  });
});
