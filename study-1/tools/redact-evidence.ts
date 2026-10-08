// Derives public/study-1-evidence/, the public redacted copy of the Study 1 packages (close-out
// Phase 3, spec limitation 10): its README, manifest and verdict recheck as plain files, and every
// package file and verification record in one archive, study-1-evidence.tar.gz.
// Usage (or `npm run redact [-- --check]`):
//   node tools/redact-evidence.ts --evidence-root <dir> --out <dir> [--check] <package-dir> ...
// Each package's verification records, under verifications/<package id>/ when that folder exists,
// are copied with it. Reads only: every original file is checked against its package-index entry,
// and nothing under the evidence root is written. Writing refuses an existing output directory;
// `--check` writes nothing and exits 1 when the copy on disk differs from a fresh derivation. It
// compares the archive after decompression, because gzip bytes depend on the zlib build, and it
// accepts the archive's files extracted in place, which git ignores.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';

import { ARCHIVE_NAME, publishedCopy } from './lib/evidence-archive.ts';
import { deriveRedactedCopy } from './lib/evidence-redaction.ts';

const USAGE = 'usage: node tools/redact-evidence.ts --evidence-root <dir> --out <dir> [--check] <package-dir> ...';

let parsed;
try {
  parsed = parseArgs({
    options: { 'evidence-root': { type: 'string' }, out: { type: 'string' }, check: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  });
} catch (error) {
  process.stderr.write(`${USAGE}; ${(error as Error).message}\n`);
  process.exit(2);
}
const { values, positionals } = parsed;
const root = values['evidence-root'];
const out = values.out;
if (root === undefined || out === undefined) {
  process.stderr.write(`${USAGE}; got ${JSON.stringify(process.argv.slice(2))}\n`);
  process.exit(2);
}

const records = positionals.flatMap((directory) => {
  const folder = `verifications/${basename(directory)}`;
  return existsSync(join(root, folder))
    ? readdirSync(join(root, folder))
        .sort()
        .map((name) => `${folder}/${name}`)
    : [];
});
const copy = deriveRedactedCopy({ packages: positionals, records, read: (path) => readFileSync(join(root, path)) });
const published = publishedCopy(copy.files);

function archiveMatches(path: string, tar: Uint8Array): boolean {
  if (!existsSync(path)) {
    return false;
  }
  try {
    return gunzipSync(readFileSync(path)).equals(tar);
  } catch {
    return false;
  }
}

if (values.check === true) {
  const onDisk = existsSync(out)
    ? readdirSync(out, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => relative(out, join(entry.parentPath, entry.name)))
    : [];
  const differing = [
    ...[...published.plain]
      .filter(([path, bytes]) => !existsSync(join(out, path)) || !readFileSync(join(out, path)).equals(bytes))
      .map(([path]) => path),
    ...(archiveMatches(join(out, ARCHIVE_NAME), published.tar) ? [] : [ARCHIVE_NAME]),
    ...onDisk.filter((path) => !published.plain.has(path) && path !== ARCHIVE_NAME && !copy.files.has(path)),
  ];
  const verdict = differing.length === 0 ? 'matches' : `DIFFERS from (${differing.slice(0, 5).join(', ')})`;
  process.stdout.write(`redacted evidence: ${out} ${verdict} a fresh derivation\n`);
  process.exitCode = differing.length === 0 ? 0 : 1;
} else {
  if (existsSync(out)) {
    process.stderr.write(`${out} already exists; expected a new directory (delete it, or use --check)\n`);
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });
  for (const [path, bytes] of published.plain) {
    writeFileSync(join(out, path), bytes);
  }
  writeFileSync(join(out, ARCHIVE_NAME), gzipSync(published.tar, { level: 9 }));
  process.stdout.write(
    `redacted evidence: wrote ${String(copy.files.size - published.plain.size)} files into ${ARCHIVE_NAME} ` +
      `and ${String(published.plain.size)} beside it in ${out}; ` +
      `${String(copy.rechecks.length)} run verdicts re-derived from the redacted ledgers\n`,
  );
}
