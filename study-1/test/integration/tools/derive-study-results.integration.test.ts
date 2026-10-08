// tools/derive-study-results.ts as a process (the owner's item 4, and the close-out note): it writes
// results.json and the study block of each --readme document, and with --check exits 1 when one
// drifts from a fresh derivation, while the text outside the block stays free. It stops when the
// packages disagree with the spec's OR-RUA-001 fixture. Fixture packages are written to a scratch
// evidence root, so the real evidence is never read.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  repositoryStatus,
  STATUS_BEGIN,
  STATUS_END,
  withRepositoryStatus,
} from '../../../tools/lib/study-results-status.ts';
import { deriveStudyResults, serializeStudyResults } from '../../../tools/lib/study-results.ts';
import {
  FINANCIAL_FIXTURE,
  LIMITATION_9,
  runInput,
  validationInput,
} from '../../unit/tools/support/execution-inputs.ts';
import { InMemoryEvidence, RUN_ID, VALIDATION_ID } from '../../unit/tools/support/in-memory-evidence.ts';

const STUDY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURE_TABLE =
  '### OR-RUA-001 — Financial fixture\n\n| Field | Value |\n|---|---:|\n| `currency` | `BRL` |\n' +
  '| `captured_amount_minor` | `10000` |\n| `approved_amount_minor` | `10000` |\n';
const SPEC = `# CAP-RUA\n\n${FIXTURE_TABLE}\n## Threats to Validity and Limitations\n\n9. ${LIMITATION_9}\n`;
const README = `# Title\n\n${STATUS_BEGIN}\n${STATUS_END}\n\nAfter.\n`;
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

// The fixture run and validation with empty verifications/ folders, the spec and a README.
function scratchStudy(readme = README, spec = SPEC): string {
  const root = mkdtempSync(join(tmpdir(), 'rua-results-'));
  scratchRoots.push(root);
  const evidence = new InMemoryEvidence();
  runInput(evidence);
  validationInput(evidence);
  for (const path of evidence.paths()) {
    mkdirSync(dirname(join(root, 'evidence', path)), { recursive: true });
    writeFileSync(join(root, 'evidence', path), evidence.read(path));
  }
  mkdirSync(join(root, 'evidence', 'verifications', RUN_ID), { recursive: true });
  mkdirSync(join(root, 'evidence', 'verifications', VALIDATION_ID), { recursive: true });
  writeFileSync(join(root, 'spec.md'), spec);
  writeFileSync(join(root, 'README.md'), readme);
  return root;
}

function results(root: string, ...extra: readonly string[]): ProcessResult {
  // NODE_TEST_CONTEXT marks a child of the test runner; a tool that sees it refuses to run files.
  const { NODE_TEST_CONTEXT: _context, ...inherited } = process.env;
  const args = [
    ...['--evidence-root', 'evidence', '--spec', 'spec.md', '--run', RUN_ID, '--validation', VALIDATION_ID],
    ...['--out', 'out/results.json', '--readme', 'README.md', ...extra],
  ];
  const result = spawnSync(process.execPath, [join(STUDY_ROOT, 'tools/derive-study-results.ts'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: inherited,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function expectedResults(): ReturnType<typeof deriveStudyResults> {
  const evidence = new InMemoryEvidence();
  return deriveStudyResults({
    runs: [runInput(evidence)],
    validations: [validationInput(evidence)],
    excludedValidations: [],
    limitation9: LIMITATION_9,
    financialFixture: FINANCIAL_FIXTURE,
  });
}

describe('derive-study-results', () => {
  it("writes results.json and fills the README's study block from the same results", () => {
    const root = scratchStudy();
    assert.deepEqual(results(root), {
      status: 0,
      stdout: 'study results: wrote out/results.json and the study block of README.md\n',
      stderr: '',
    });
    const derived = expectedResults();
    assert.equal(readFileSync(join(root, 'out/results.json'), 'utf8'), serializeStudyResults(derived));
    assert.equal(
      readFileSync(join(root, 'README.md'), 'utf8'),
      withRepositoryStatus(README, repositoryStatus(derived)),
    );
  });

  it('checks both files: free text outside the block passes, a drifted block or results file fails', () => {
    const root = scratchStudy();
    results(root);
    const check = (): ProcessResult => results(root, '--check');
    const matches = 'study results: out/results.json matches a fresh derivation\n';
    assert.deepEqual(check(), {
      status: 0,
      stdout: `${matches}study results: README.md matches a fresh derivation\n`,
      stderr: '',
    });
    const readme = join(root, 'README.md');
    const filled = readFileSync(readme, 'utf8');
    writeFileSync(readme, filled.replace('After.', 'After, edited by hand.'));
    assert.equal(check().status, 0);
    writeFileSync(readme, filled.replace('| 1 | `CONTROL`', '| 1 | `COMMIT_THEN_TIMEOUT`'));
    assert.deepEqual(check(), {
      status: 1,
      stdout: `${matches}study results: README.md DIFFERS from a fresh derivation\n`,
      stderr: '',
    });
    writeFileSync(readme, filled);
    const out = join(root, 'out/results.json');
    writeFileSync(out, readFileSync(out, 'utf8').replace('"pass"', '"fail"'));
    assert.deepEqual(check(), {
      status: 1,
      stdout:
        'study results: out/results.json DIFFERS from a fresh derivation\n' +
        'study results: README.md matches a fresh derivation\n',
      stderr: '',
    });
  });

  it('fills and checks the study block of every --readme document', () => {
    const root = scratchStudy();
    const note = join(root, 'STUDY-1.md');
    writeFileSync(note, `# Close-out\n\n${STATUS_BEGIN}\n${STATUS_END}\n`);
    assert.deepEqual(results(root, '--readme', 'STUDY-1.md'), {
      status: 0,
      stdout: 'study results: wrote out/results.json and the study block of README.md and STUDY-1.md\n',
      stderr: '',
    });
    const status = repositoryStatus(expectedResults());
    assert.equal(readFileSync(note, 'utf8'), `# Close-out\n\n${STATUS_BEGIN}\n${status}${STATUS_END}\n`);
    writeFileSync(note, readFileSync(note, 'utf8').replace('`10000`', '`20000`'));
    assert.deepEqual(results(root, '--readme', 'STUDY-1.md', '--check'), {
      status: 1,
      stdout:
        'study results: out/results.json matches a fresh derivation\n' +
        'study results: README.md matches a fresh derivation\n' +
        'study results: STUDY-1.md DIFFERS from a fresh derivation\n',
      stderr: '',
    });
  });

  it('stops when the packages disagree with the OR-RUA-001 fixture, writing nothing', () => {
    const root = scratchStudy(README, SPEC.replace('| `currency` | `BRL` |', '| `currency` | `USD` |'));
    const result = results(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /runs\/[0-9a-f-]+ states currency BRL; expected OR-RUA-001's currency USD/);
    assert.throws(() => readFileSync(join(root, 'out/results.json')), /ENOENT/);
  });

  it('fails on a README without the study block markers, writing nothing', () => {
    const root = scratchStudy('# Title\n');
    const result = results(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the README holds 0 begin and 0 end study-results markers/);
    assert.throws(() => readFileSync(join(root, 'out/results.json')), /ENOENT/);
  });
});
