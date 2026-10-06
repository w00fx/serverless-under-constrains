// Mutation gate (design §15.3). Usage:
//   node tools/mutation-gate.ts <mutation.json> [--expect <glob> ...]
// Every mutation target of quality/mutation-targets.json (its include globs minus its exclude
// globs, recomputed from the tree) must be in the report, as must every file matching an
// --expect glob. Stryker's JSON report lists only files that have mutants, so without this a
// target that was never mutated would pass unseen (WP-00 review round 1). A target with no
// runtime code has no mutants and is never in the report; it is listed as excluded by the human
// decision A-10 (the policy's `type_only: "excluded"`), the verdict it gets when the report does
// list it (WP-00 review round 2).

import { globSync, readFileSync } from 'node:fs';
import process from 'node:process';

import {
  evaluateMutationGate,
  formatGateReport,
  parseEquivalences,
  parseMutationReport,
} from './lib/mutation-report.ts';
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
const result = evaluateMutationGate(
  files,
  equivalences,
  expected.map((path) => ({ path, source: readFileSync(path, 'utf8') })),
);

for (const line of formatGateReport(result)) {
  process.stdout.write(`${line}\n`);
}
process.exitCode = result.passed ? 0 : 1;
