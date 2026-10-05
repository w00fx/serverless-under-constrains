// Copies the mutation-target policy into .c8rc.json and stryker.config.json (design §15.4).
// `--check` writes nothing and exits 1 on drift (run by `npm run lint`).

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

import { applyMutationTargets, parseMutationTargetPolicy, qualityConfigDrift } from './lib/quality-config.ts';
import type { JsonRecord } from './lib/quality-config.ts';

const C8_PATH = '.c8rc.json';
const STRYKER_PATH = 'stryker.config.json';
const readRecord = (path: string): JsonRecord => JSON.parse(readFileSync(path, 'utf8')) as JsonRecord;

const policy = parseMutationTargetPolicy(JSON.parse(readFileSync('quality/mutation-targets.json', 'utf8')));
const c8 = readRecord(C8_PATH);
const stryker = readRecord(STRYKER_PATH);

if (process.argv.includes('--check')) {
  const drift = qualityConfigDrift(policy, c8, stryker);
  for (const line of drift) {
    process.stderr.write(`quality config drift: ${line}\n`);
  }
  process.stdout.write(
    `quality config: ${drift.length === 0 ? 'in sync with' : 'DRIFTED from'} quality/mutation-targets.json\n`,
  );
  process.exitCode = drift.length === 0 ? 0 : 1;
} else {
  const updated = applyMutationTargets(policy, c8, stryker);
  writeFileSync(C8_PATH, `${JSON.stringify(updated.c8, null, 2)}\n`);
  writeFileSync(STRYKER_PATH, `${JSON.stringify(updated.stryker, null, 2)}\n`);
  process.stdout.write(`quality config: wrote ${C8_PATH} and ${STRYKER_PATH} from quality/mutation-targets.json\n`);
}
