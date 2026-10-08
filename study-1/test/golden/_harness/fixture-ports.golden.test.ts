// Conformance of the golden generator's port emulators (WP-09): the shared suites run against the
// local bindings in a temporary directory and against `MemoryFixtureFileSystem` and
// `StaticCaseModuleLoader`, so the unit tests of the generator exercise fakes that behave like
// the real file system and module loader. They live in the golden suite because the generator's
// bindings exist for `npm run test:golden`.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { NodeCaseModuleLoader } from '../../../tools/golden/lib/case-module-loader.ts';
import { NodeFixtureFileSystem } from '../../../tools/golden/lib/fixture-file-system.ts';
import type { CaseModuleLoaderUnderTest } from '../../support/golden-builder/fixture-ports-conformance.ts';
import {
  describeCaseModuleLoaderConformance,
  describeFixtureFileSystemConformance,
} from '../../support/golden-builder/fixture-ports-conformance.ts';
import { MemoryFixtureFileSystem } from '../../support/golden-builder/memory-fixture-file-system.ts';
import { StaticCaseModuleLoader } from '../../support/golden-builder/static-case-module-loader.ts';
import type { StaticCaseModule } from '../../support/golden-builder/static-case-module-loader.ts';

const directories: string[] = [];

after(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'rua-golden-ports-'));
  directories.push(directory);
  return directory;
}

function moduleSource(module: StaticCaseModule): string {
  if (module.kind === 'default_export') {
    return `export default ${JSON.stringify(module.value)};\n`;
  }
  return module.kind === 'throws'
    ? `throw new Error(${JSON.stringify(module.message)});\n`
    : 'export const unused = 1;\n';
}

describeFixtureFileSystemConformance('NodeFixtureFileSystem', () => new NodeFixtureFileSystem(temporaryRoot()));
describeFixtureFileSystemConformance('MemoryFixtureFileSystem', () => new MemoryFixtureFileSystem());

describeCaseModuleLoaderConformance('NodeCaseModuleLoader', (): CaseModuleLoaderUnderTest => {
  const root = temporaryRoot();
  return {
    loader: new NodeCaseModuleLoader(root),
    register: (path, module): void => {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, moduleSource(module));
    },
  };
});

describeCaseModuleLoaderConformance('StaticCaseModuleLoader', (): CaseModuleLoaderUnderTest => {
  const modules = new Map<string, StaticCaseModule>();
  return {
    loader: new StaticCaseModuleLoader(modules),
    register: (path, module): void => {
      modules.set(path, module);
    },
  };
});

// A-05 regression (WP-09 single-pass review): `String(error)` threw on a thrown value with no
// callable `toString`, ending the generator run, and copied any message length into the report.
describe('NodeCaseModuleLoader thrown values', () => {
  const root = temporaryRoot();
  const loadThrowing = async (name: string, statement: string): Promise<string> => {
    const caseFile = `test/golden/x/cases/${name}.case.ts`;
    mkdirSync(join(root, 'test/golden/x/cases'), { recursive: true });
    writeFileSync(join(root, caseFile), `${statement}\n`);
    const loaded = await new NodeCaseModuleLoader(root).load(caseFile);
    return loaded.ok ? '' : loaded.error;
  };

  it('reports a thrown value with no text form instead of throwing', async () => {
    assert.equal(
      await loadThrowing('bare', 'throw Object.create(null);'),
      'test/golden/x/cases/bare.case.ts failed to load (a thrown value with no text form); expected an importable module',
    );
  });

  it('bounds a long thrown message', async () => {
    assert.equal(
      await loadThrowing('long', `throw new Error('${'m'.repeat(1000)}');`),
      `test/golden/x/cases/long.case.ts failed to load (Error: ${'m'.repeat(193)}…[truncated]); expected an importable module`,
    );
  });
});
