// Derives results/study-1/results.json from the frozen evidence packages (close-out Phase 1), and
// the study block of the README's "Repository status" from those results.
// Usage (or `npm run results [-- --check]`):
//   node tools/derive-study-results.ts --evidence-root <dir> --spec <spec.md> --run <id>
//     [--validation <id> ...] [--excluded-validation <id> ...] --out <results.json>
//     --readme <README.md> [--check]
// Reads only: every package file is checked against its package-index entry, and nothing under
// the evidence root is written. `--check` writes nothing and exits 1 when the results file or the
// README's study block differs from a fresh derivation.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

import type { EvidenceFileReader } from './lib/study-results-reading.ts';
import type { ExecutionInput, ExecutionKind } from './lib/study-results-execution.ts';
import { repositoryStatus, withRepositoryStatus } from './lib/study-results-status.ts';
import { deriveStudyResults, limitationOf, parseDeriveArguments, serializeStudyResults } from './lib/study-results.ts';

let args;
try {
  args = parseDeriveArguments(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(2);
}

const root = args.evidenceRoot;
const read: EvidenceFileReader = (path) => readFileSync(join(root, path));
const inputOf = (kind: ExecutionKind, id: string): ExecutionInput => ({
  kind,
  id,
  read,
  verifications: readdirSync(join(root, 'verifications', id))
    .sort()
    .map((name) => ({ path: `verifications/${id}/${name}`, bytes: read(`verifications/${id}/${name}`) })),
});

const results = deriveStudyResults({
  runs: args.runs.map((id) => inputOf('run', id)),
  validations: args.validations.map((id) => inputOf('variant_validation', id)),
  excludedValidations: args.excludedValidations.map((id) => inputOf('variant_validation', id)),
  limitation9: limitationOf(readFileSync(args.spec, 'utf8'), 9),
});
const serialized = serializeStudyResults(results);
const readmeOnDisk = readFileSync(args.readme, 'utf8');
const readme = withRepositoryStatus(readmeOnDisk, repositoryStatus(results));

if (args.check) {
  const committed = existsSync(args.out) ? readFileSync(args.out, 'utf8') : '';
  const checks: readonly (readonly [string, boolean])[] = [
    [args.out, committed === serialized],
    [args.readme, readmeOnDisk === readme],
  ];
  for (const [path, inSync] of checks) {
    process.stdout.write(`study results: ${path} ${inSync ? 'matches' : 'DIFFERS from'} a fresh derivation\n`);
  }
  process.exitCode = checks.every(([, inSync]) => inSync) ? 0 : 1;
} else {
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, serialized);
  writeFileSync(args.readme, readme);
  process.stdout.write(`study results: wrote ${args.out} and the study block of ${args.readme}\n`);
}
