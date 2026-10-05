// Module-boundary check (design §5.4), run by `npm run lint`.

import { globSync, readFileSync } from 'node:fs';
import process from 'node:process';

import { checkModuleBoundaries, parseBoundaryConfig } from './lib/module-boundaries.ts';
import { extractImports } from './lib/source-imports.ts';

const config = parseBoundaryConfig(JSON.parse(readFileSync('quality/module-boundaries.json', 'utf8')));
const paths = [...globSync('src/**/*.ts'), ...globSync('infra/**/*.ts')].sort();
const files = paths.map((path) => {
  const text = readFileSync(path, 'utf8');
  return { path, text, imports: extractImports(path, text) };
});
const violations = checkModuleBoundaries(config, files);
for (const violation of violations) {
  process.stderr.write(`${violation.path}: ${violation.rule}: ${violation.detail}\n`);
}
process.stdout.write(
  `module boundaries: ${String(files.length)} file(s) checked, ${String(violations.length)} violation(s)\n`,
);
process.exitCode = violations.length === 0 ? 0 : 1;
