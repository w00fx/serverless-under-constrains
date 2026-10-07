// tools/redact-evidence.ts as a process (close-out Phase 3): it writes the public redacted copy to
// a new directory, its README, manifest and verdict recheck beside one archive of the package files
// and of each package's verification records when its verifications/ folder exists. It refuses an
// existing directory, and with --check exits 0 only when the copy on disk equals a fresh derivation,
// naming the files that differ: the archive is compared after decompression, and its files
// extracted in place are accepted. Fixture packages are written to a scratch evidence root, so the
// real evidence is never read.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

import { ARCHIVE_NAME, PLAIN_FILES } from '../../../tools/lib/evidence-archive.ts';
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
  it("writes the plain files and one archive of every other file, the packages' records included", () => {
    const root = scratchEvidence();
    const result = redact(root, '--evidence-root', 'evidence', '--out', 'copy', ...PACKAGES);
    assert.deepEqual(result, {
      status: 0,
      stdout:
        `redacted evidence: wrote 19 files into ${ARCHIVE_NAME} and 3 beside it in copy; ` +
        '2 run verdicts re-derived from the redacted ledgers\n',
      stderr: '',
    });
    assert.deepEqual(readdirSync(join(root, 'copy')).sort(), [...PLAIN_FILES, ARCHIVE_NAME].sort());
    const extracted = spawnSync('tar', ['-xzf', ARCHIVE_NAME], { cwd: join(root, 'copy'), encoding: 'utf8' });
    assert.deepEqual([extracted.status, extracted.stderr], [0, '']);
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
      stdout: `redacted evidence: copy DIFFERS from (redaction-manifest.json, verdict-recheck.json, README.md, ${ARCHIVE_NAME}) a fresh derivation\n`,
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
    writeFileSync(join(root, 'copy', 'extra.json'), '{}');
    assert.equal(check().stdout, 'redacted evidence: copy DIFFERS from (extra.json) a fresh derivation\n');
    rmSync(join(root, 'copy', 'extra.json'));
    rmSync(join(root, 'copy', 'README.md'));
    assert.equal(check().stdout, 'redacted evidence: copy DIFFERS from (README.md) a fresh derivation\n');
  });

  it('compares the archive after decompression and accepts its files extracted in place', () => {
    const root = scratchEvidence();
    const check = (): ProcessResult =>
      redact(root, '--evidence-root', 'evidence', '--out', 'copy', '--check', ...PACKAGES);
    const archive = join(root, 'copy', ARCHIVE_NAME);
    const differs = `redacted evidence: copy DIFFERS from (${ARCHIVE_NAME}) a fresh derivation\n`;
    redact(root, '--evidence-root', 'evidence', '--out', 'copy', ...PACKAGES);
    const tar = gunzipSync(readFileSync(archive));
    writeFileSync(archive, gzipSync(tar, { level: 1 }));
    assert.equal(check().status, 0, 'other gzip bytes of the same tar still match');
    spawnSync('tar', ['-xzf', ARCHIVE_NAME], { cwd: join(root, 'copy') });
    assert.deepEqual(check(), {
      status: 0,
      stdout: 'redacted evidence: copy matches a fresh derivation\n',
      stderr: '',
    });
    writeFileSync(archive, gzipSync(tar.subarray(512)));
    assert.equal(check().stdout, differs);
    writeFileSync(archive, 'not gzip');
    assert.equal(check().stdout, differs);
    rmSync(archive);
    assert.equal(check().stdout, differs);
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
