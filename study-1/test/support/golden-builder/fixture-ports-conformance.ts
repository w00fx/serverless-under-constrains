// The conformance suites of the golden generator's two ports. Each runs unchanged against the
// local binding (in a temporary directory) and against its in-memory emulator, so the emulators
// the unit tests use cannot drift from the bindings `npm run test:golden` uses: glob discovery,
// sorted relative listings, copy-on-read and copy-on-write bytes, idempotent deletion, and the
// three ways loading a case module ends.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CaseModuleLoader, CaseModuleResult } from '../../../tools/golden/lib/case-module-loader.ts';
import type { FixtureFileSystem } from '../../../tools/golden/lib/fixture-file-system.ts';
import type { StaticCaseModule } from './static-case-module-loader.ts';

const encoder = new TextEncoder();

// The error of a failed load, or a marker no failure pattern matches.
function loadError(loaded: CaseModuleResult): string {
  return loaded.ok ? '<loaded>' : loaded.error;
}
const bytesOf = (text: string): Uint8Array => encoder.encode(text);

/**
 * Declares the FixtureFileSystem conformance cases; `subjectFactory` returns an empty file system.
 *
 * @example
 * describeFixtureFileSystemConformance('MemoryFixtureFileSystem', () => new MemoryFixtureFileSystem());
 */
export function describeFixtureFileSystemConformance(name: string, subjectFactory: () => FixtureFileSystem): void {
  describe(`${name} conforms to the FixtureFileSystem contract`, () => {
    it('answers empty for an empty root', () => {
      const files = subjectFactory();
      assert.deepEqual(files.findCaseFiles(), []);
      assert.deepEqual(files.findFixtureDirectories(), []);
      assert.deepEqual(files.listFiles('test/golden/x/fixtures/a'), []);
      assert.equal(files.readFile('test/golden/x/fixtures/a/b.json'), undefined);
    });

    it('writes a file under new parent directories and reads its exact bytes back', () => {
      const files = subjectFactory();
      files.writeFile('test/golden/x/fixtures/a/deep/b.json', bytesOf('{"a":1}\n'));
      assert.deepEqual(files.readFile('test/golden/x/fixtures/a/deep/b.json'), bytesOf('{"a":1}\n'));
      files.writeFile('test/golden/x/fixtures/a/deep/b.json', bytesOf('2'));
      assert.deepEqual(files.readFile('test/golden/x/fixtures/a/deep/b.json'), bytesOf('2'));
    });

    it('keeps stored bytes apart from the caller buffers', () => {
      const files = subjectFactory();
      const written = bytesOf('abc');
      files.writeFile('test/golden/x/fixtures/a/b.json', written);
      written[0] = 0x7a;
      const read = files.readFile('test/golden/x/fixtures/a/b.json');
      assert.deepEqual(read, bytesOf('abc'));
      read.fill(0x7a);
      assert.deepEqual(files.readFile('test/golden/x/fixtures/a/b.json'), bytesOf('abc'));
    });

    it('finds case files at any depth under test/golden, sorted, and nothing else', () => {
      const files = subjectFactory();
      for (const path of [
        'test/golden/y/deeper/cases/b.case.ts',
        'test/golden/cases/root.case.ts',
        'test/golden/x/cases/a.case.ts',
        'test/golden/x/cases/a.ts',
        'test/golden/x/cases/sub/c.case.ts',
        'test/unit/x/cases/d.case.ts',
        'test/golden/x/fixtures/a/cases/e.case.ts.json',
      ]) {
        files.writeFile(path, bytesOf('export default {};\n'));
      }
      assert.deepEqual(files.findCaseFiles(), [
        'test/golden/cases/root.case.ts',
        'test/golden/x/cases/a.case.ts',
        'test/golden/y/deeper/cases/b.case.ts',
      ]);
    });

    it('finds fixture directories, not files directly under fixtures/ or their subdirectories', () => {
      const files = subjectFactory();
      files.writeFile('test/golden/x/fixtures/b/runner/runner-journal.jsonl', bytesOf('{}\n'));
      files.writeFile('test/golden/x/fixtures/a/inputs.json', bytesOf('{}\n'));
      files.writeFile('test/golden/y/z/fixtures/c/d.json', bytesOf('{}\n'));
      files.writeFile('test/golden/x/fixtures/loose.json', bytesOf('{}\n'));
      assert.deepEqual(files.findFixtureDirectories(), [
        'test/golden/x/fixtures/a',
        'test/golden/x/fixtures/b',
        'test/golden/y/z/fixtures/c',
      ]);
    });

    it('lists every file below a directory relative to it, sorted, excluding name-prefix siblings', () => {
      const files = subjectFactory();
      files.writeFile('test/golden/x/fixtures/a/trials/t/z.json', bytesOf('1'));
      files.writeFile('test/golden/x/fixtures/a/admission/m.json', bytesOf('1'));
      files.writeFile('test/golden/x/fixtures/ab/other.json', bytesOf('1'));
      assert.deepEqual(files.listFiles('test/golden/x/fixtures/a'), ['admission/m.json', 'trials/t/z.json']);
    });

    it('deletes a file, ignores an absent one, and reads a directory as absent', () => {
      const files = subjectFactory();
      files.writeFile('test/golden/x/fixtures/a/b.json', bytesOf('1'));
      files.writeFile('test/golden/x/fixtures/a/c.json', bytesOf('1'));
      files.deleteFile('test/golden/x/fixtures/a/b.json');
      files.deleteFile('test/golden/x/fixtures/a/never.json');
      assert.equal(files.readFile('test/golden/x/fixtures/a/b.json'), undefined);
      assert.equal(files.readFile('test/golden/x/fixtures/a'), undefined);
      assert.deepEqual(files.listFiles('test/golden/x/fixtures/a'), ['c.json']);
    });
  });
}

/** A loader under test and a way to put a module at a root-relative path. */
export interface CaseModuleLoaderUnderTest {
  readonly loader: CaseModuleLoader;
  /** Makes `path` a module that behaves as `module` describes; each path is registered once. */
  register(path: string, module: StaticCaseModule): void;
}

/**
 * Declares the CaseModuleLoader conformance cases for one implementation.
 *
 * @example
 * describeCaseModuleLoaderConformance('StaticCaseModuleLoader', () => staticSubject());
 */
export function describeCaseModuleLoaderConformance(
  name: string,
  subjectFactory: () => CaseModuleLoaderUnderTest,
): void {
  describe(`${name} conforms to the CaseModuleLoader contract`, () => {
    it('returns the default export of a module', async () => {
      const subject = subjectFactory();
      const value = { case_id: 'a', nested: [1, 'two', null] };
      subject.register('test/golden/x/cases/a.case.ts', { kind: 'default_export', value });
      assert.deepEqual(await subject.loader.load('test/golden/x/cases/a.case.ts'), { ok: true, value });
    });

    it('reports a module without a default export, naming the path', async () => {
      const subject = subjectFactory();
      subject.register('test/golden/x/cases/b.case.ts', { kind: 'no_default_export' });
      const loaded = await subject.loader.load('test/golden/x/cases/b.case.ts');
      assert.match(loadError(loaded), /^test\/golden\/x\/cases\/b\.case\.ts has no default export/);
    });

    it('reports a module that throws while it loads, with its message', async () => {
      const subject = subjectFactory();
      subject.register('test/golden/x/cases/c.case.ts', { kind: 'throws', message: 'case module exploded' });
      const loaded = await subject.loader.load('test/golden/x/cases/c.case.ts');
      assert.match(loadError(loaded), /^test\/golden\/x\/cases\/c\.case\.ts failed to load \(.*case module exploded/);
    });

    it('reports an absent module as a load failure', async () => {
      const subject = subjectFactory();
      const loaded = await subject.loader.load('test/golden/x/cases/absent.case.ts');
      assert.match(loadError(loaded), /^test\/golden\/x\/cases\/absent\.case\.ts failed to load \(/);
    });
  });
}
