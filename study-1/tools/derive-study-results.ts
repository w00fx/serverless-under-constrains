// Derives results/study-1/results.json from the frozen evidence packages (close-out Phase 1).
// Usage (or `npm run results [-- --check]`):
//   node tools/derive-study-results.ts --evidence-root <dir> --spec <spec.md> --run <id>
//     [--validation <id> ...] --out <results.json> [--check]
// Reads only: every package file is checked against its package-index entry, and nothing under
// the evidence root is written. `--check` writes nothing and exits 1 when the file differs from a
// fresh derivation.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

import type { EvidenceFileReader } from './lib/study-results-reading.ts';
import type { ExecutionInput, ExecutionKind } from './lib/study-results.ts';
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

const results = deriveStudyResults(
  [...args.runs.map((id) => inputOf('run', id)), ...args.validations.map((id) => inputOf('variant_validation', id))],
  limitationOf(readFileSync(args.spec, 'utf8'), 9),
);
const serialized = serializeStudyResults(results);

if (args.check) {
  const committed = existsSync(args.out) ? readFileSync(args.out, 'utf8') : '';
  const inSync = committed === serialized;
  process.stdout.write(`study results: ${args.out} ${inSync ? 'matches' : 'DIFFERS from'} a fresh derivation\n`);
  process.exitCode = inSync ? 0 : 1;
} else {
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, serialized);
  process.stdout.write(`study results: wrote ${args.out}\n`);
}
