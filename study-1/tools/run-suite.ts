// Suite runner with the zero-test guard (design §12.1, §15.1).
// Usage: node tools/run-suite.ts <suite> <glob> [<glob> ...] [--report-json <file>]
// Exits 1 on zero tests, any failure, any skip or todo, or fewer tests than the summed
// `quality/suite-minimums/*.json` minimum of the suite. `--report-json` writes the counts and
// the passing test names (the admission oracle attestation reads them, design §10.1 A9).

import { globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

import { e2eRefusal, evaluateSuiteRun, parseSuiteMinimums, sumSuiteMinimum } from './lib/suite-accounting.ts';
import type { SuiteCounts } from './lib/suite-accounting.ts';

const args = process.argv.slice(2);
const reportIndex = args.indexOf('--report-json');
const reportPath = reportIndex === -1 ? undefined : args[reportIndex + 1];
const positional =
  reportIndex === -1 ? args : args.filter((_, index) => index !== reportIndex && index !== reportIndex + 1);
const [suite, ...patterns] = positional;

if (suite === undefined || patterns.length === 0 || (reportIndex !== -1 && reportPath === undefined)) {
  process.stderr.write(
    `usage: node tools/run-suite.ts <suite> <glob> [...glob] [--report-json <file>]; got ${JSON.stringify(args)}\n`,
  );
  process.exit(2);
}
const refusal = suite === 'e2e' ? e2eRefusal(process.env) : undefined;
if (refusal !== undefined) {
  process.stderr.write(`${refusal}\n`);
  process.exit(1);
}

const minimumFiles = globSync('quality/suite-minimums/*.json').sort();
const minimum = sumSuiteMinimum(
  minimumFiles.map((file) => parseSuiteMinimums(file, JSON.parse(readFileSync(file, 'utf8')))),
  suite,
);
const files = patterns.flatMap((pattern) => globSync(pattern)).sort();
const passedTests: { readonly file: string; readonly name: string }[] = [];
let counts: SuiteCounts = { tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0 };

const stream = run({ files: [...new Set(files)], concurrency: true });
stream.on('test:pass', (event) => {
  if (event.details.type === 'test' && event.skip === undefined && event.todo === undefined) {
    passedTests.push({ file: event.file ?? '', name: event.name });
  }
});
stream.on('test:summary', (event) => {
  if (event.file === undefined) {
    const { tests, passed, cancelled, skipped, todo } = event.counts;
    // @types/node 24 does not declare `counts.failed`; every test not otherwise classified failed.
    counts = { tests, passed, failed: tests - passed - cancelled - skipped - todo, cancelled, skipped, todo };
  }
});
stream.on('end', () => {
  const verdict = evaluateSuiteRun(suite, counts, minimum);
  process.stdout.write(
    `run-suite ${suite}: ${String(files.length)} file(s), ${String(counts.tests)} test(s), ${String(counts.passed)} passed, ` +
      `${String(counts.failed)} failed, ${String(counts.skipped)} skipped, ${String(counts.todo)} todo; minimum ${String(minimum)}\n`,
  );
  for (const problem of verdict.problems) {
    process.stderr.write(`run-suite ${suite}: ${problem}\n`);
  }
  if (reportPath !== undefined) {
    mkdirSync(dirname(reportPath), { recursive: true });
    const report = {
      suite,
      patterns,
      files,
      counts,
      minimum,
      exit_code: verdict.exitCode,
      problems: verdict.problems,
      passed_tests: passedTests,
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.exitCode = verdict.exitCode;
});
stream.compose(spec).pipe(process.stdout);
