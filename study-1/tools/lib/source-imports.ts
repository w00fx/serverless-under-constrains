// Static import extraction for the module-boundary check (design §5.4). It parses the file
// with the TypeScript compiler, so imports in comments or strings never count and type-only
// imports are told apart from value imports.

import ts from 'typescript';

export interface ImportReference {
  readonly specifier: string;
  /** True when the import is erased at runtime (`import type`, or every specifier type-only). */
  readonly typeOnly: boolean;
}

/**
 * Lists every module a TypeScript source file references: static imports, re-exports,
 * dynamic `import()` with a literal specifier, and `import x = require(...)`.
 *
 * @example
 * extractImports('a.ts', "import type { X } from './x.ts';"); // [{ specifier: './x.ts', typeOnly: true }]
 */
export function extractImports(fileName: string, text: string): readonly ImportReference[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: ImportReference[] = [];
  const visit = (node: ts.Node): void => {
    const reference = importReferenceOf(node);
    if (reference !== undefined) {
      found.push(reference);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Tells whether a module has no runtime code after type stripping: every top-level
 * statement is an interface, a type alias, a type-only import or a type-only export.
 *
 * @example
 * isTypeOnlyModule('export interface A { readonly x: 1 }'); // true
 * isTypeOnlyModule('export const A = 1;'); // false
 */
export function isTypeOnlyModule(text: string): boolean {
  const source = ts.createSourceFile('module.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return source.statements.every(isTypeOnlyStatement);
}

function importReferenceOf(node: ts.Node): ImportReference | undefined {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    return { specifier: node.moduleSpecifier.text, typeOnly: isTypeOnlyImportClause(node.importClause) };
  }
  if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
    return { specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly };
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    const expression = node.moduleReference.expression;
    return ts.isStringLiteral(expression) ? { specifier: expression.text, typeOnly: node.isTypeOnly } : undefined;
  }
  if (isDynamicImport(node)) {
    const [argument] = node.arguments;
    return argument !== undefined && ts.isStringLiteral(argument)
      ? { specifier: argument.text, typeOnly: false }
      : undefined;
  }
  return undefined;
}

function isDynamicImport(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

function isTypeOnlyImportClause(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined) {
    return false;
  }
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) {
    return true;
  }
  const bindings = clause.namedBindings;
  return (
    clause.name === undefined &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

function isTypeOnlyStatement(statement: ts.Statement): boolean {
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
    return true;
  }
  if (ts.isImportDeclaration(statement)) {
    return isTypeOnlyImportClause(statement.importClause);
  }
  return ts.isExportDeclaration(statement) && statement.isTypeOnly;
}
