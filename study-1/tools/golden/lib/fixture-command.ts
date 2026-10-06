// The generator command: argument parsing, the check and write runs, and their plain-text report
// (user-facing CLI output). Ports are injected, so the whole command runs against the in-memory
// fakes in tests and against the study tree in `npm run test:golden`.

import type { CaseModuleLoader } from './case-module-loader.ts';
import type { FixtureFileSystem } from './fixture-file-system.ts';
import {
  compareFixture,
  generateFixtures,
  handAuthoredFixtureDirectories,
  orphanFixtureDirectories,
  writeFixture,
} from './fixture-generation.ts';

/** The parsed command line. */
export interface FixtureCommandOptions {
  readonly check: boolean;
  readonly overwrite: ReadonlySet<string>;
}

/** What the command prints and how it exits. */
export interface FixtureCommandOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit_code: number;
}

/** The command's ports. */
export interface FixtureCommandPorts {
  readonly files: FixtureFileSystem;
  readonly loader: CaseModuleLoader;
}

const USAGE = 'usage: node tools/golden/generate-fixtures.ts [--check] [--overwrite <case-id>]... [--root <dir>]';

/**
 * Parses the command line; `--root` is consumed by the entry point and ignored here.
 *
 * @example
 * parseFixtureArguments(['--check']); // { ok: true, value: { check: true, overwrite: Set {} } }
 */
export function parseFixtureArguments(
  args: readonly string[],
): { readonly ok: true; readonly value: FixtureCommandOptions } | { readonly ok: false; readonly error: string } {
  let check = false;
  const overwrite = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--check') {
      check = true;
      continue;
    }
    const value = args[index + 1];
    if ((arg !== '--overwrite' && arg !== '--root') || value === undefined || value.startsWith('--')) {
      return { ok: false, error: `argument ${JSON.stringify(arg)} in ${JSON.stringify(args)}; ${USAGE}` };
    }
    index += 1;
    if (arg === '--overwrite') {
      overwrite.add(value);
    }
  }
  if (check && overwrite.size > 0) {
    return { ok: false, error: `--check with --overwrite ${[...overwrite].join(', ')}; expected one mode. ${USAGE}` };
  }
  return { ok: true, value: { check, overwrite } };
}

/**
 * Runs the generator: `--check` compares, otherwise it writes missing fixtures.
 *
 * @example
 * const outcome = await runFixtureCommand(['--check'], { files, loader });
 * outcome.exit_code; // 0 when every committed fixture is reproduced byte for byte
 */
export async function runFixtureCommand(
  args: readonly string[],
  ports: FixtureCommandPorts,
): Promise<FixtureCommandOutcome> {
  const options = parseFixtureArguments(args);
  if (!options.ok) {
    return { stdout: '', stderr: `${options.error}\n`, exit_code: 2 };
  }
  const report = await generateFixtures(ports.files.findCaseFiles(), ports.loader);
  const errors = [...report.problems];
  const lines: string[] = [];
  const unknownOverwrites = [...options.value.overwrite].filter(
    (caseId) => !report.fixtures.some((fixture) => fixture.case_id === caseId),
  );
  errors.push(
    ...unknownOverwrites.map((caseId) => `--overwrite ${caseId}: no case has that id; expected an existing case id`),
  );
  for (const fixture of report.fixtures) {
    if (options.value.check) {
      const discrepancies = compareFixture(ports.files, fixture);
      errors.push(...discrepancies.map((item) => `${item.path}: ${item.kind}; expected the regenerated fixture bytes`));
      continue;
    }
    const outcome = writeFixture(ports.files, fixture, options.value.overwrite.has(fixture.case_id));
    lines.push(`${fixture.case_id}: ${outcome}`);
    if (outcome === 'refused') {
      errors.push(
        `${fixture.fixture_directory}: committed fixture differs from its case; expected an unchanged fixture or --overwrite ${fixture.case_id}`,
      );
    }
  }
  errors.push(
    ...orphanFixtureDirectories(ports.files, report.fixtures).map(
      (directory) => `${directory}: no case owns this fixture directory; expected a sibling cases/<case-id>.case.ts`,
    ),
  );
  lines.push(
    ...handAuthoredFixtureDirectories(ports.files).map(
      (directory) => `${directory}: hand-authored fixture, neither generated nor checked (no cases/ beside it)`,
    ),
  );
  const mode = options.value.check ? 'check' : 'write';
  lines.push(
    `golden fixtures (${mode}): ${String(report.fixtures.length)} case(s), ${String(errors.length)} problem(s)`,
  );
  return {
    stdout: `${lines.join('\n')}\n`,
    stderr: errors.map((error) => `${error}\n`).join(''),
    exit_code: errors.length === 0 ? 0 : 1,
  };
}
