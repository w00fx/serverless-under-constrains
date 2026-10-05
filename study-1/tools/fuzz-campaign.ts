// Generative fuzz campaign (design §12.5, testing rule 7). Usage:
//   node tools/fuzz-campaign.ts --runs <n> --campaigns <k> <glob> [<glob> ...]
// Runs every fuzz file k times, each with a fresh random seed (FC_SEED) and n runs per
// property (FC_RUNS), and writes reports/fuzz/<target>.json. Exits 1 on any failure or on a
// target with zero properties.

import { randomInt } from 'node:crypto';
import { globSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { run } from 'node:test';

import { buildFuzzReport, fuzzTargetName } from './lib/fuzz-report.ts';
import type { CampaignFailure, CampaignRun } from './lib/fuzz-report.ts';

const args = process.argv.slice(2);
const option = (name: string): number => {
  const raw = args[args.indexOf(name) + 1];
  const value = Number(raw);
  if (!args.includes(name) || !Number.isSafeInteger(value) || value <= 0) {
    process.stderr.write(`${name} is ${JSON.stringify(raw)}; expected a positive integer\n`);
    process.exit(2);
  }
  return value;
};
const runs = option('--runs');
const campaigns = option('--campaigns');
const patterns = args.filter((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--'));
const version = (createRequire(import.meta.url)('fast-check/package.json') as { readonly version: string }).version;
const tool = `fast-check@${version}`;

async function runCampaign(file: string, seed: number): Promise<CampaignRun> {
  let passed = 0;
  const failures: CampaignFailure[] = [];
  const stream = run({ files: [file], env: { ...process.env, FC_RUNS: String(runs), FC_SEED: String(seed) } });
  stream.on('test:pass', (event) => {
    passed += event.details.type === 'test' ? 1 : 0;
  });
  stream.on('test:fail', (event) => {
    if (event.details.type === 'test') {
      const error = event.details.error as { readonly cause?: unknown; readonly message?: string };
      failures.push({
        test: event.name,
        message: String(error.cause instanceof Error ? error.cause.message : error.message),
      });
    }
  });
  for await (const _ of stream) {
    // Drain the stream; the listeners above collect the results.
  }
  return { seed, passed, failures };
}

let failed = false;
for (const file of [...new Set(patterns.flatMap((pattern) => globSync(pattern)))].sort()) {
  const results: CampaignRun[] = [];
  for (let campaign = 0; campaign < campaigns; campaign += 1) {
    results.push(await runCampaign(file, randomInt(2 ** 31 - 1)));
  }
  const report = buildFuzzReport({ tool, target: fuzzTargetName(file), runs, campaigns: results });
  const destination = join('reports', 'fuzz', `${report.target}.json`);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
  failed ||= report.failures > 0 || report.properties === 0;
  process.stdout.write(
    `${report.target}: ${String(report.properties)} property run(s), ${String(report.executed)} case(s), seeds ${report.seeds.join(',')}, failures ${String(report.failures)} -> ${destination}\n`,
  );
}
process.exitCode = failed ? 1 : 0;
