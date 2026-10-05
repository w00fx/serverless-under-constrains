// Static import extraction for the module-boundary check (design §5.4).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractImports, isTypeOnlyModule } from '../../../tools/lib/source-imports.ts';

describe('extractImports', () => {
  it('finds static, re-exported, import-equals and dynamic imports with their type-only flag', () => {
    const text = [
      "import a from './a.ts';",
      "import type { B } from './b.ts';",
      "import { type C, type D } from './c.ts';",
      "import { type E, F } from './e.ts';",
      "import G, { type H } from './g.ts';",
      "import * as I from './i.ts';",
      "import './side-effect.ts';",
      "import {} from './empty.ts';",
      "export { J } from './j.ts';",
      "export type { K } from './k.ts';",
      "export * from './star.ts';",
      "import L = require('./l.cjs');",
      "import type M = require('./m.cjs');",
      "const n = await import('./n.ts');",
      'const o = await import(dynamicName);',
      'export { local };',
      "// import x from './commented.ts';",
      'const text = "import y from \'./in-string.ts\'";',
      'import N = Namespace.Member;',
    ].join('\n');
    assert.deepEqual(extractImports('src/x/y.ts', text), [
      { specifier: './a.ts', typeOnly: false },
      { specifier: './b.ts', typeOnly: true },
      { specifier: './c.ts', typeOnly: true },
      { specifier: './e.ts', typeOnly: false },
      { specifier: './g.ts', typeOnly: false },
      { specifier: './i.ts', typeOnly: false },
      { specifier: './side-effect.ts', typeOnly: false },
      { specifier: './empty.ts', typeOnly: false },
      { specifier: './j.ts', typeOnly: false },
      { specifier: './k.ts', typeOnly: true },
      { specifier: './star.ts', typeOnly: false },
      { specifier: './l.cjs', typeOnly: false },
      { specifier: './m.cjs', typeOnly: true },
      { specifier: './n.ts', typeOnly: false },
    ]);
  });

  it('finds imports nested inside functions', () => {
    assert.deepEqual(extractImports('a.ts', "async function f(): Promise<void> { await import('node:fs'); }"), [
      { specifier: 'node:fs', typeOnly: false },
    ]);
  });

  it('ignores a dynamic import without arguments and computed module references', () => {
    assert.deepEqual(extractImports('a.ts', 'const p = import();'), []);
    assert.deepEqual(extractImports('a.ts', 'import L = require(moduleName);'), []);
  });
});

describe('isTypeOnlyModule', () => {
  it('recognizes modules erased entirely by type stripping', () => {
    assert.equal(isTypeOnlyModule(''), true);
    assert.equal(
      isTypeOnlyModule(
        "import type { A } from './a.ts';\nexport interface B { readonly a: A }\nexport type C = B;\nexport type { A };",
      ),
      true,
    );
    assert.equal(isTypeOnlyModule("import { type A } from './a.ts';\nexport type B = A;"), true);
  });

  it('recognizes runtime code', () => {
    assert.equal(isTypeOnlyModule('export const A = 1;'), false);
    assert.equal(isTypeOnlyModule("import './side-effect.ts';"), false);
    assert.equal(isTypeOnlyModule("import { A } from './a.ts';\nexport type B = typeof A;"), false);
    assert.equal(isTypeOnlyModule("export { A } from './a.ts';"), false);
    assert.equal(isTypeOnlyModule('export function f(): void {}'), false);
  });
});
