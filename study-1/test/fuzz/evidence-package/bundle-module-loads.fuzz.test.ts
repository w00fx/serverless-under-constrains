// Properties of the syntax-aware RK-12 bundle scan (design §9.8 S3, §12.5; testing rule 6; A-14
// fix of the text scan, 2026-10-06):
// - total: any text, and any mix of the characters that switch the scanner's state, yields a
//   boolean without throwing, and a load is never reported unless the text names `@aws-sdk/`;
// - exact on valid modules: for a module composed of statements that load the SDK, load other
//   modules, quote SDK loads in literals and comments, or put a quote right after a token whose
//   regular-expression-or-division reading matters, the verdict equals both the composition's
//   truth and the TypeScript parser's syntax tree (an independent oracle).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';
import ts from 'typescript';

import { loadsBareAwsSdk } from '../../../src/evidence-package/bundle-module-loads.ts';
import { loadedModules } from '../../support/deployment-assembly/bundle-imports.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

/** Statements that load a bare SDK module at run time. */
const SDK_LOADS = [
  'import "@aws-sdk/m";',
  'import {} from "@aws-sdk/m";',
  "export * from '@aws-sdk/m';",
  "export {} from '@aws-sdk/m';",
  'v = require("@aws-sdk/m");',
  "v = __require('@aws-sdk/m');",
  'v = await import("@aws-sdk/m");',
  'v = `${require("@aws-sdk/m")}`;',
  'v = [...require("@aws-sdk/m")];',
  'if (a) { v = require("@aws-sdk/m"); }',
  'function g() { return import("@aws-sdk/m"); }',
] as const;

/** Statements that load nothing from the SDK, many of them quoting a load or a quote character. */
const OTHER_STATEMENTS = [
  'import "node:fs";',
  'v = require("node:path");',
  'v = "require(\\"@aws-sdk/m\\")";',
  'v = \'import "@aws-sdk/m"\';',
  'v = `from "@aws-sdk/m"`;',
  'v = `a${b}require("@aws-sdk/m")`;',
  '// require("@aws-sdk/m")',
  '/* import "@aws-sdk/m"; */',
  'v = /[from "@aws-sdk/]/u;',
  'obj.require("@aws-sdk/m");',
  'obj.import("@aws-sdk/m");',
  'v = import.meta.url;',
  'v = a / b / c;',
  'v = x++ / 2;',
  'v = f(x) / 2;',
  'v = list[0] / 2;',
  'v = y.return / 2;',
  "if (a) /'/.test(b);",
  "while (a) /'/.exec(b);",
  'v = /["\'`]/g;',
  "function h(z) { return /'/.test(z); }",
  "{ }\n/'/.test(b);",
  'v = .5 / 2;',
  'v = a + /"/.source;',
  'v = `x${`y${b}`}`;',
  'v = { k: 1 }.k / 2;',
  "v = '/';",
  'v = "\'";',
] as const;

const SCANNER_PIECES = [
  '/',
  '*',
  '"',
  "'",
  '`',
  '${',
  '{',
  '}',
  '(',
  ')',
  '[',
  ']',
  '.',
  '...',
  '+',
  '++',
  '\\',
  '\n',
  ' ',
  'a',
  '1',
  'if',
  'return',
  'require',
  'import',
  'from',
  '"@aws-sdk/a"',
] as const;

const statement = fc.oneof(
  fc.constantFrom(...SDK_LOADS).map((text) => ({ text, loads: true })),
  fc.constantFrom(...OTHER_STATEMENTS).map((text) => ({ text, loads: false })),
);

function syntaxErrors(source: string): readonly string[] {
  const output = ts.transpileModule(source, {
    fileName: 'bundle.mjs',
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext, allowJs: true },
  });
  return (output.diagnostics ?? []).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
}

describe('loadsBareAwsSdk properties', () => {
  it('is total on any text and reports a load only where the text names @aws-sdk/ (property)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 200 }), (source) => {
        const found = loadsBareAwsSdk(source);
        assert.equal(typeof found, 'boolean');
        assert.ok(!found || source.includes('@aws-sdk/'));
      }),
      fuzzParameters(),
    );
  });

  it('is total on any mix of the characters that switch its state (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...SCANNER_PIECES), { maxLength: 60 }), (pieces) => {
        const source = pieces.join('');
        const found = loadsBareAwsSdk(source);
        assert.ok(!found || source.includes('@aws-sdk/'));
      }),
      fuzzParameters(),
    );
  });

  it('agrees with the composition and the TypeScript syntax tree on valid modules (property)', () => {
    fc.assert(
      fc.property(fc.array(statement, { minLength: 1, maxLength: 10 }), (statements) => {
        const source = statements.map((entry) => entry.text).join('\n');
        assert.deepEqual(syntaxErrors(source), [], source);
        const expected = statements.some((entry) => entry.loads);
        const parsed = loadedModules(source).some((specifier) => specifier.startsWith('@aws-sdk/'));
        assert.equal(parsed, expected, `oracle: ${source}`);
        assert.equal(loadsBareAwsSdk(source), expected, source);
      }),
      fuzzParameters(),
    );
  });
});
