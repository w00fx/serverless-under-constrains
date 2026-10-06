// Mutation gate (design §15.3). Usage:
//   node tools/mutation-gate.ts <mutation.json> [--expect <glob> ...]
// Every mutation target of quality/mutation-targets.json (its include globs minus its exclude
// globs, recomputed from the tree) must be in the report, as must every file matching an
// --expect glob. Stryker's JSON report lists only files that have mutants, so without this a
// target that was never mutated would pass unseen (WP-00 review round 1).

import { globSync, readFileSync } from 'node:fs';
import process from 'node:process';

import { evaluateMutationGate, parseEquivalences, parseMutationReport } from './lib/mutation-report.ts';
import { parseMutationTargetPolicy } from './lib/quality-config.ts';

const [reportPath, ...rest] = process.argv.slice(2);
const expectGlobs = rest.flatMap((arg, index) => (rest[index - 1] === '--expect' ? [arg] : []));
if (reportPath === undefined || rest.length !== expectGlobs.length * 2) {
  process.stderr.write(
    `usage: node tools/mutation-gate.ts <mutation.json> [--expect <glob> ...]; got ${JSON.stringify(process.argv.slice(2))}\n`,
  );
  process.exit(2);
}

const files = parseMutationReport(JSON.parse(readFileSync(reportPath, 'utf8')));
const equivalences = parseEquivalences(JSON.parse(readFileSync('quality/mutation-equivalences.json', 'utf8')));
const policy = parseMutationTargetPolicy(JSON.parse(readFileSync('quality/mutation-targets.json', 'utf8')));
const targets = globSync([...policy.include], { exclude: [...policy.exclude] });
const expected = [...new Set([...targets, ...expectGlobs.flatMap((pattern) => globSync(pattern))])].sort();
const result = evaluateMutationGate(files, equivalences, expected);

for (const file of result.files) {
  const c = file.counts;
  process.stdout.write(
    `${file.verdict.padEnd(10)} ${file.path}: valid ${String(file.valid)}, killed ${String(c.Killed)}, timeout ${String(c.Timeout)}, ` +
      `survived ${String(c.Survived)} (accepted ${String(file.accepted_equivalent)}), no-coverage ${String(c.NoCoverage)}, ` +
      `runtime-error ${String(c.RuntimeError)}, compile-error ${String(c.CompileError)}, ignored ${String(c.Ignored)}, pending ${String(c.Pending)}\n`,
  );
  for (const problem of file.problems) {
    process.stdout.write(`    ${problem}\n`);
  }
  for (const timeout of file.timeouts) {
    process.stdout.write(`    review timeout: ${timeout}\n`);
  }
}
for (const problem of result.problems) {
  process.stdout.write(`gate: ${problem}\n`);
}
process.stdout.write(
  `mutation gate: ${result.passed ? 'PASSED' : 'FAILED'} over ${String(result.files.length)} file(s)\n`,
);
process.exitCode = result.passed ? 0 : 1;
