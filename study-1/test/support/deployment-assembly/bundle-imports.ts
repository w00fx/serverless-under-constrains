// The module specifiers a bundled `.mjs` really loads at run time (design §9.13 case 4g; RK-12):
// static imports and re-exports, dynamic `import()`, and calls of `require` or esbuild's
// `__require` with a string literal, read from the TypeScript parser's syntax tree. Text inside
// string literals and comments is not code: the SDK's own error messages quote
// `require("@aws-sdk/signature-v4-crt")`, and a text scan would count them as imports.

import ts from 'typescript';

const REQUIRE_NAMES: ReadonlySet<string> = new Set(['require', '__require']);

/**
 * Every module specifier `source` loads, in order of appearance.
 *
 * @example
 * loadedModules('import { a } from "node:fs"; const b = require("x");'); // ['node:fs', 'x']
 */
export function loadedModules(source: string): readonly string[] {
  const file = ts.createSourceFile('bundle.mjs', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const found: string[] = [];
  const pending: ts.Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const specifier = loadedSpecifier(node);
    if (specifier !== undefined) {
      found.push(specifier);
    }
    pending.push(...node.getChildren(file).toReversed());
  }
  return found;
}

function loadedSpecifier(node: ts.Node): string | undefined {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
    return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
  }
  if (!ts.isCallExpression(node)) {
    return undefined;
  }
  const [argument] = node.arguments;
  const loads =
    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && REQUIRE_NAMES.has(node.expression.text));
  return loads && argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}
