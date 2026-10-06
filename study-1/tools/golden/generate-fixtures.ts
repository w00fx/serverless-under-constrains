// Golden fixture generator (design §12.4, WP-09).
// Usage: node tools/golden/generate-fixtures.ts [--check] [--overwrite <case-id>]... [--root <dir>]
// Without --check it writes the fixture of every case that has none and refuses to replace a
// committed fixture unless its case id is named with --overwrite. With --check it regenerates
// every case in memory and exits 1 on any missing, extra or differing file, any orphan fixture
// directory beside a cases/ directory or any case that fails to load, parse or build; a fixture
// directory in a golden directory without cases is hand-authored and only listed in the report.
// The process exit status is the result.

import process from 'node:process';

import { runFixtureCommand } from './lib/fixture-command.ts';
import { NodeCaseModuleLoader } from './lib/case-module-loader.ts';
import { NodeFixtureFileSystem } from './lib/fixture-file-system.ts';

const root = rootOf(process.argv.slice(2)) ?? process.cwd();
const outcome = await runFixtureCommand(process.argv.slice(2), {
  files: new NodeFixtureFileSystem(root),
  loader: new NodeCaseModuleLoader(root),
});
process.stdout.write(outcome.stdout);
process.stderr.write(outcome.stderr);
process.exitCode = outcome.exit_code;

function rootOf(args: readonly string[]): string | undefined {
  const index = args.indexOf('--root');
  return index === -1 ? undefined : args[index + 1];
}
