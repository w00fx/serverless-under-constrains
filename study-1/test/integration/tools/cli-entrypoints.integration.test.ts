// The gate entry points as processes (design §12.1, §15.1-§15.4): exit codes and messages of
// run-suite, mutation-gate, generate-quality-config, check-module-boundaries and fuzz-campaign,
// each run in a scratch study tree so the real repository is never touched. They spawn child
// processes and write a real filesystem, so they are integration tests (Owner amendment A-11:
// test/integration/tools/ is WP-00's).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const STUDY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const scratchRoots: string[] = [];
after(() => {
  for (const root of scratchRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface ProcessResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function scratchTree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'rua-cli-'));
  scratchRoots.push(root);
  symlinkSync(join(STUDY_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function runTool(
  cwd: string,
  tool: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): ProcessResult {
  // NODE_TEST_CONTEXT marks a child of the test runner; a tool that sees it refuses to run files.
  const { RUA_E2E_ENV: _env, RUA_E2E_CONFIRM: _confirm, NODE_TEST_CONTEXT: _context, ...inherited } = process.env;
  const result = spawnSync(process.execPath, [join(STUDY_ROOT, 'tools', tool), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...inherited, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const PASSING_TEST = "import { it } from 'node:test';\nit('adds', () => {});\nit('subtracts', () => {});\n";

describe('run-suite', () => {
  it('passes a green suite and writes the report with the passing test names', () => {
    const root = scratchTree({
      'quality/suite-minimums/demo.json': '{"unit": 2}',
      'test/unit/demo/a.test.ts': PASSING_TEST,
    });
    const result = runTool(root, 'run-suite.ts', [
      'unit',
      'test/unit/**/*.test.ts',
      '--report-json',
      'reports/unit.json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /run-suite unit: 1 file\(s\), 2 test\(s\), 2 passed, 0 failed, 0 skipped, 0 todo; minimum 2/,
    );
    const report = JSON.parse(readFileSync(join(root, 'reports/unit.json'), 'utf8')) as {
      readonly exit_code: number;
      readonly passed_tests: readonly { readonly name: string }[];
    };
    assert.equal(report.exit_code, 0);
    assert.deepEqual(report.passed_tests.map((test) => test.name).toSorted(), ['adds', 'subtracts']);
  });

  it('fails a glob that matches no test', () => {
    const root = scratchTree({});
    const result = runTool(root, 'run-suite.ts', ['golden', 'test/golden/**/*.golden.test.ts']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /zero tests executed for suite golden; zero tests is not verification/);
  });

  it('fails skipped, todo and failing tests and a count below the minimum', () => {
    const root = scratchTree({
      'quality/suite-minimums/demo.json': '{"unit": 9}',
      'test/unit/demo/a.test.ts':
        "import assert from 'node:assert/strict';\nimport { it } from 'node:test';\nit('skipped', { skip: true }, () => {});\nit('todo', { todo: true }, () => {});\nit('fails', () => { assert.equal(1, 2); });\n",
    });
    const result = runTool(root, 'run-suite.ts', ['unit', 'test/unit/**/*.test.ts']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /1 failed and 0 cancelled test\(s\); expected none/);
    assert.match(result.stderr, /1 skipped and 1 todo test\(s\); expected none/);
    assert.match(result.stderr, /3 test\(s\) ran; expected at least the summed minimum 9/);
  });

  it('refuses e2e without both opt-in variables and rejects bad usage', () => {
    const root = scratchTree({});
    const refused = runTool(root, 'run-suite.ts', ['e2e', 'test/e2e/**/*.test.ts']);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /e2e refuses to start: RUA_E2E_ENV and RUA_E2E_CONFIRM not set/);
    assert.equal(runTool(root, 'run-suite.ts', ['unit']).status, 2);
    assert.equal(runTool(root, 'run-suite.ts', ['unit', 'x', '--report-json']).status, 2);
  });
});

describe('mutation-gate', () => {
  const report = (status: string): string =>
    JSON.stringify({
      files: {
        'src/a.ts': {
          source: 'export const a = 1;',
          mutants: [
            {
              id: '1',
              mutatorName: 'NumericLiteral',
              replacement: '0',
              status,
              location: { start: { line: 1, column: 18 } },
            },
          ],
        },
      },
    });

  it('passes a fully killed report and fails a survivor or a missing expected file', () => {
    const root = scratchTree({
      'quality/mutation-equivalences.json': '{"equivalences": []}',
      'quality/mutation-targets.json': '{"include": ["src/**/*.ts"], "exclude": ["src/b.ts"], "type_only": "excluded"}',
      'killed.json': report('Killed'),
      'survived.json': report('Survived'),
      'src/a.ts': '',
      'src/b.ts': 'export const b = 2;\n',
    });
    const killed = runTool(root, 'mutation-gate.ts', ['killed.json', '--expect', 'src/a.ts']);
    assert.equal(killed.status, 0, killed.stdout);
    assert.match(killed.stdout, /passed {5}src\/a\.ts: valid 1, killed 1/);
    assert.match(killed.stdout, /mutation gate: PASSED over 1 measured file\(s\), 0 excluded \(A-10\)/);
    const survived = runTool(root, 'mutation-gate.ts', ['survived.json']);
    assert.equal(survived.status, 1);
    assert.match(survived.stdout, /Survived NumericLiteral at 1:18 -> "0"/);
    const missing = runTool(root, 'mutation-gate.ts', ['killed.json', '--expect', 'src/*.ts']);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /missing {4}src\/b\.ts/);
    assert.equal(runTool(root, 'mutation-gate.ts', []).status, 2);
    assert.equal(runTool(root, 'mutation-gate.ts', ['killed.json', '--expect']).status, 2);
  });

  it('fails a policy target absent from the report without any --expect, and an Ignored mutant', () => {
    const root = scratchTree({
      'quality/mutation-equivalences.json': '{"equivalences": []}',
      'quality/mutation-targets.json':
        '{"include": ["src/**/*.ts"], "exclude": ["src/aws/**"], "type_only": "excluded"}',
      'killed.json': report('Killed'),
      'ignored.json': report('Ignored'),
      'src/a.ts': '',
      'src/c/d.ts': 'export const d = 1;\n',
      'src/c/types.ts': 'export interface T { readonly t: 1 }\n',
      'src/aws/adapter.ts': '',
    });
    const missing = runTool(root, 'mutation-gate.ts', ['killed.json']);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /missing {4}src\/c\/d\.ts/);
    // A target with no runtime code never appears in a Stryker report (review round 2).
    // Human decision A-10: it is excluded, never missing or unmeasured, and not a measured file.
    assert.match(
      missing.stdout,
      /excluded {3}src\/c\/types\.ts: excluded by human decision A-10: a type-only module has no runtime code to mutate/,
    );
    assert.match(
      missing.stdout,
      /type-only targets excluded by human decision A-10 \(no runtime code; never missing or unmeasured\): 1/,
    );
    assert.doesNotMatch(missing.stdout, /src\/aws\/adapter\.ts/);
    assert.match(missing.stdout, /mutation gate: FAILED over 2 measured file\(s\), 1 excluded \(A-10\)/);
    const ignored = runTool(root, 'mutation-gate.ts', ['ignored.json']);
    assert.equal(ignored.status, 1);
    assert.match(ignored.stdout, /Ignored NumericLiteral at 1:18 -> "0"/);
  });
});

describe('generate-quality-config', () => {
  it('detects drift with --check and repairs it without --check', () => {
    const root = scratchTree({});
    for (const file of ['quality/mutation-targets.json', '.c8rc.json', 'stryker.config.json']) {
      cpSync(join(STUDY_ROOT, file), join(root, file), { recursive: true });
    }
    assert.equal(runTool(root, 'generate-quality-config.ts', ['--check']).status, 0);
    const c8 = JSON.parse(readFileSync(join(root, '.c8rc.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(root, '.c8rc.json'), JSON.stringify({ ...c8, include: ['src/**/*.ts'] }));
    const drifted = runTool(root, 'generate-quality-config.ts', ['--check']);
    assert.equal(drifted.status, 1);
    assert.match(drifted.stderr, /quality config drift: \.c8rc\.json include is \["src\/\*\*\/\*\.ts"\]/);
    assert.equal(runTool(root, 'generate-quality-config.ts', []).status, 0);
    assert.equal(runTool(root, 'generate-quality-config.ts', ['--check']).status, 0);
  });
});

describe('check-module-boundaries', () => {
  it('reports each violation and exits 1, and exits 0 on a clean tree', () => {
    const config = readFileSync(join(STUDY_ROOT, 'quality/module-boundaries.json'), 'utf8');
    const clean = scratchTree({
      'quality/module-boundaries.json': config,
      'src/settlement/s.ts': "import { a } from '../record-contract/r.ts';\n",
    });
    assert.equal(runTool(clean, 'check-module-boundaries.ts', []).status, 0);
    const dirty = scratchTree({
      'quality/module-boundaries.json': config,
      'src/record-contract/r.ts': "import { s } from '../settlement/s.ts';\n",
    });
    const result = runTool(dirty, 'check-module-boundaries.ts', []);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /src\/record-contract\/r\.ts: OUTWARD_IMPORT: record-contract \(L0\) imports settlement \(L1\)/,
    );
  });
});

describe('fuzz-campaign', () => {
  const property = (body: string): string =>
    `import { it } from 'node:test';\nimport fc from 'fast-check';\nconst runs = Number(process.env['FC_RUNS']);\nconst seed = Number(process.env['FC_SEED']);\nit('property', () => { fc.assert(fc.property(fc.integer({ min: 0, max: 1000 }), (n) => ${body}), { numRuns: runs, seed }); });\n`;

  it('runs every campaign with a recorded seed and writes the report', () => {
    const root = scratchTree({ 'test/fuzz/demo/ok.fuzz.test.ts': property('n >= 0') });
    const result = runTool(root, 'fuzz-campaign.ts', [
      '--runs',
      '25',
      '--campaigns',
      '2',
      'test/fuzz/**/*.fuzz.test.ts',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(join(root, 'reports/fuzz/demo/ok.json'), 'utf8')) as {
      readonly tool: string;
      readonly seeds: readonly number[];
      readonly executed: number;
      readonly properties: number;
      readonly mode: string;
    };
    assert.match(report.tool, /^fast-check@\d+\.\d+\.\d+$/);
    assert.equal(report.mode, 'generative');
    assert.equal(report.seeds.length, 2);
    assert.equal(report.properties, 2);
    assert.equal(report.executed, 50);
  });

  it('fails a falsified property and keeps its seed and counterexample', () => {
    const root = scratchTree({ 'test/fuzz/demo/bad.fuzz.test.ts': property('n < 50') });
    const result = runTool(root, 'fuzz-campaign.ts', [
      '--runs',
      '200',
      '--campaigns',
      '1',
      'test/fuzz/**/*.fuzz.test.ts',
    ]);
    assert.equal(result.status, 1);
    const report = JSON.parse(readFileSync(join(root, 'reports/fuzz/demo/bad.json'), 'utf8')) as {
      readonly seeds: readonly number[];
      readonly counterexamples: readonly {
        readonly seed?: number;
        readonly counterexample?: string;
        readonly campaign_seed: number;
      }[];
    };
    assert.equal(report.counterexamples[0]?.counterexample, '[50]');
    assert.equal(report.counterexamples[0].seed, report.seeds[0]);
  });

  it('rejects a missing or non-positive budget', () => {
    const root = scratchTree({});
    assert.equal(runTool(root, 'fuzz-campaign.ts', ['--runs', '0', '--campaigns', '1', 'x']).status, 2);
    assert.equal(runTool(root, 'fuzz-campaign.ts', ['--campaigns', '1', 'x']).status, 2);
  });
});
