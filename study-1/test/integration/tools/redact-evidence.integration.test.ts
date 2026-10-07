// tools/redact-evidence.ts as a process (close-out Phase 3): it writes the public redacted copy to
// a new directory, with each package's verification records when its verifications/ folder exists,
// refuses an existing directory, and with --check exits 0 only when the copy on disk equals a fresh
// derivation, naming the files that differ. Fixture packages are written to a scratch evidence
// root, so the real evidence is never read.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { deriveRedactedCopy } from '../../../tools/lib/evidence-redaction.ts';
import type { InMemoryEvidence } from '../../unit/tools/support/in-memory-evidence.ts';
import {
  DOUBLE_REFUND,
  PASSING,
  PROBE,
  probePackageFiles,
  redactionEvidence,
  RUN,
  runPackageFiles,
} from '../../unit/tools/support/redaction-evidence.ts';

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

// The run's one verification record; the probe has no verifications/ folder.
const RECORD = `verifications/${RUN.slice('runs/'.length)}/2026-10-07T06:00:00.000Z-package-verification.json`;

function fixtureEvidence(): InMemoryEvidence {
  const evidence = redactionEvidence();
  evidence.put(RECORD, { record_type: 'package_verification', package_eligibility: 'eligible' });
  return evidence;
}

// A scratch evidence root holding the fixture run and probe packages and the run's record, byte for byte.
function scratchEvidence(): string {
  const root = mkdtempSync(join(tmpdir(), 'rua-redact-'));
  scratchRoots.push(root);
  const evidence = fixtureEvidence();
  const paths = [
    ...[...runPackageFiles([PASSING, DOUBLE_REFUND]).keys(), 'package-index.json'].map((path) => `${RUN}/${path}`),
    ...[...probePackageFiles().keys(), 'package-index.json'].map((path) => `${PROBE}/${path}`),
    RECORD,
  ];
  for (const path of paths) {
    mkdirSync(dirname(join(root, 'evidence', path)), { recursive: true });
    writeFileSync(join(root, 'evidence', path), evidence.read(path));
  }
  return root;
}

function redact(root: string, ...args: readonly string[]): ProcessResult {
  // NODE_TEST_CONTEXT marks a child of the test runner; a tool that sees it refuses to run files.
  const { NODE_TEST_CONTEXT: _context, ...inherited } = process.env;
  const result = spawnSync(process.execPath, [join(STUDY_ROOT, 'tools/redact-evidence.ts'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: inherited,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const PACKAGES = [RUN, PROBE];

describe('redact-evidence', () => {
  it("writes every file of the derived copy, with the packages' verification records, to a new directory", () => {
    const root = scratchEvidence();
    const result = redact(root, '--evidence-root', 'evidence', '--out', 'copy', ...PACKAGES);
    assert.deepEqual(result, {
      status: 0,
      stdout: 'redacted evidence: wrote 22 files to copy; 2 run verdicts re-derived from the redacted ledgers\n',
      stderr: '',
    });
    const expected = deriveRedactedCopy({ packages: PACKAGES, records: [RECORD], read: fixtureEvidence().read });
    assert.ok(expected.files.has(RECORD));
    for (const [path, bytes] of expected.files) {
      assert.deepEqual(new Uint8Array(readFileSync(join(root, 'copy', path))), bytes, path);
    }
  });

  it('refuses to write over an existing directory', () => {
    const root = scratchEvidence();
    mkdirSync(join(root, 'copy'));
    assert.deepEqual(redact(root, '--evidence-root', 'evidence', '--out', 'copy', ...PACKAGES), {
      status: 2,
      stdout: '',
      stderr: 'copy already exists; expected a new directory (delete it, or use --check)\n',
    });
  });

  it('checks a copy on disk: equal, a changed, missing or extra file, or no copy at all', () => {
    const root = scratchEvidence();
    const check = (): ProcessResult =>
      redact(root, '--evidence-root', 'evidence', '--out', 'copy', '--check', ...PACKAGES);
    assert.deepEqual(check(), {
      status: 1,
      stdout: `redacted evidence: copy DIFFERS from (${RUN}/package-index.json, ${RUN}/admission/deployment-assembly/stack.metadata.json, ${RUN}/admission/oracle-attestation.json, ${RUN}/admission/deployment-assembly/asset.1/index.mjs, ${RUN}/trials/${PASSING.id}/trial-manifest.json) a fresh derivation\n`,
      stderr: '',
    });
    redact(root, '--evidence-root', 'evidence', '--out', 'copy', ...PACKAGES);
    assert.deepEqual(check(), {
      status: 0,
      stdout: 'redacted evidence: copy matches a fresh derivation\n',
      stderr: '',
    });
    const manifest = join(root, 'copy', 'redaction-manifest.json');
    const original = readFileSync(manifest);
    writeFileSync(manifest, `${original.toString()} `);
    assert.deepEqual(check(), {
      status: 1,
      stdout: 'redacted evidence: copy DIFFERS from (redaction-manifest.json) a fresh derivation\n',
      stderr: '',
    });
    writeFileSync(manifest, original);
    writeFileSync(join(root, 'copy', RUN, 'extra.json'), '{}');
    assert.equal(check().stdout, `redacted evidence: copy DIFFERS from (${RUN}/extra.json) a fresh derivation\n`);
    rmSync(join(root, 'copy', RUN, 'extra.json'));
    rmSync(join(root, 'copy', 'README.md'));
    assert.equal(check().stdout, 'redacted evidence: copy DIFFERS from (README.md) a fresh derivation\n');
  });

  it('exits 2 with the usage on a missing or unknown flag', () => {
    const root = scratchEvidence();
    const usage = 'usage: node tools/redact-evidence.ts --evidence-root <dir> --out <dir> [--check] <package-dir> ...';
    assert.deepEqual(redact(root, '--evidence-root', 'evidence', RUN), {
      status: 2,
      stdout: '',
      stderr: `${usage}; got ["--evidence-root","evidence","${RUN}"]\n`,
    });
    const unknown = redact(root, '--evidence-root', 'evidence', '--out', 'copy', '--other', RUN);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /^usage: node tools\/redact-evidence\.ts .*; Unknown option '--other'/);
  });

  it('fails on a package directory outside the evidence kinds, writing nothing', () => {
    const root = scratchEvidence();
    const result = redact(root, '--evidence-root', 'evidence', '--out', 'copy', '../evidence');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /got packages \["\.\.\/evidence"\]; expected at least one distinct/);
    assert.throws(() => readFileSync(join(root, 'copy', 'README.md')), /ENOENT/);
  });
});
