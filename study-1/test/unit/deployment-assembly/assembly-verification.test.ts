// Proof that a directory still is the frozen assembly (design §9.8 D1, D3; BR-RUA-042; RK-13): an
// intact inventory is required, the directory is re-inventoried with the same canonical inventory,
// and every added, removed or changed file is one reason, capped at 20 listed differences. The
// listing reads every regular file and never a link.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readAssemblyListing } from '../../../src/deployment-assembly/assembly-listing.ts';
import {
  inventoryDifferences,
  inventorySelfCheck,
  MAX_LISTED_DIFFERENCES,
  verifyAssemblyUnchanged,
} from '../../../src/deployment-assembly/assembly-verification.ts';
import type { AssemblyListing } from '../../../src/deployment-assembly/assembly-listing.ts';
import type { Sha256Hex } from '../../../src/record-contract/primitives.ts';
import type { AssemblyFileEntry } from '../../../src/record-contract/records/group-a/deployment_assembly_inventory.ts';
import { frozenInventory, placeAssembly } from '../../support/deployment-assembly/deployment-fixtures.ts';
import { MemoryAssemblyFileSystem } from '../../support/deployment-assembly/memory-assembly-file-system.ts';

const DIR = '/pkg/admission/deployment-assembly';
const encoder = new TextEncoder();

async function frozenRig(): Promise<{
  readonly files: MemoryAssemblyFileSystem;
  readonly inventory: Awaited<ReturnType<typeof frozenInventory>>;
}> {
  const files = new MemoryAssemblyFileSystem();
  await placeAssembly(files, DIR);
  return { files, inventory: await frozenInventory(files, DIR) };
}

async function listing(files: MemoryAssemblyFileSystem): Promise<AssemblyListing> {
  const listed = await readAssemblyListing(files, DIR);
  if (!listed.ok) {
    throw new Error(`listing failed: ${JSON.stringify(listed.error)}`);
  }
  return listed.value;
}

function entry(path: string, sha = 'a'): AssemblyFileEntry {
  return { path, bytes: 1, mode: '0644', sha256: sha.repeat(64) as Sha256Hex };
}

describe('verifyAssemblyUnchanged (D3)', () => {
  it('finds nothing in an untouched assembly', async () => {
    const { files, inventory } = await frozenRig();
    assert.deepEqual(verifyAssemblyUnchanged(inventory, await listing(files)), []);
  });

  it('names an added lock file, a removed file and a changed file', async () => {
    const { files, inventory } = await frozenRig();
    await files.createFile(`${DIR}/read.4242.1.lock`, encoder.encode('4242'), 0o644);
    await files.removeFile(`${DIR}/manifest.json`);
    files.corrupt(`${DIR}/asset.abc123/index.mjs`);
    const reasons = verifyAssemblyUnchanged(inventory, await listing(files));
    assert.deepEqual(
      reasons.map((reason) => [reason.code, reason.subject]),
      [
        ['FILE_CHANGED', 'BR-RUA-042'],
        ['FILE_REMOVED', 'BR-RUA-042'],
        ['FILE_ADDED', 'BR-RUA-042'],
      ],
    );
    assert.match(reasons[1]?.detail ?? '', /^"manifest\.json" is missing; expected the frozen file of 20 bytes$/);
    assert.match(reasons[2]?.detail ?? '', /^"read\.4242\.1\.lock" is not in the frozen inventory/);
  });

  it('returns the inventory rejection of a directory that holds a link', async () => {
    const { files, inventory } = await frozenRig();
    files.placeSpecial(`${DIR}/escape.json`, 'symlink');
    const reasons = verifyAssemblyUnchanged(inventory, await listing(files));
    assert.deepEqual(
      reasons.map((reason) => reason.code),
      ['NON_REGULAR_FILE'],
    );
  });

  it('refuses an inventory whose digest does not match its files', async () => {
    const { files, inventory } = await frozenRig();
    const reasons = verifyAssemblyUnchanged(
      { ...inventory, inventory_sha256: '0'.repeat(64) as Sha256Hex },
      await listing(files),
    );
    assert.deepEqual(
      reasons.map((reason) => reason.code),
      ['INVENTORY_DIGEST_MISMATCH'],
    );
    assert.equal(inventorySelfCheck(inventory), undefined);
  });

  it('lists at most 20 differences and counts the rest', async () => {
    const { files, inventory } = await frozenRig();
    for (let index = 0; index < 25; index += 1) {
      await files.createFile(`${DIR}/flood/${String(index).padStart(2, '0')}.lock`, encoder.encode('x'), 0o644);
    }
    const reasons = verifyAssemblyUnchanged(inventory, await listing(files));
    assert.equal(reasons.length, MAX_LISTED_DIFFERENCES + 1);
    const count = reasons.at(MAX_LISTED_DIFFERENCES);
    assert.ok(count !== undefined);
    assert.equal(count.code, 'MORE_DIFFERENCES');
    assert.match(count.detail, /^5 further difference\(s\) are not listed/);
  });

  it('lists exactly 20 differences without a count', async () => {
    const { files, inventory } = await frozenRig();
    for (let index = 0; index < MAX_LISTED_DIFFERENCES; index += 1) {
      await files.createFile(`${DIR}/flood/${String(index).padStart(2, '0')}.lock`, encoder.encode('x'), 0o644);
    }
    const reasons = verifyAssemblyUnchanged(inventory, await listing(files));
    assert.deepEqual(new Set(reasons.map((reason) => reason.code)), new Set(['FILE_ADDED']));
    assert.equal(reasons.length, MAX_LISTED_DIFFERENCES);
  });
});

describe('inventoryDifferences', () => {
  it('names each changed field with the current and frozen values', () => {
    const frozen = entry('a.json');
    const [reason] = inventoryDifferences(
      [frozen],
      [{ ...frozen, bytes: 2, mode: '0600', sha256: 'b'.repeat(64) as Sha256Hex }],
    );
    assert.equal(
      reason?.detail,
      `"a.json" has bytes 2 (frozen 1), mode 0600 (frozen 0644), sha256 ${'b'.repeat(64)} (frozen ${'a'.repeat(64)}); expected the frozen bytes, mode and digest`,
    );
  });

  it('is empty exactly for equal lists, and lists removals and changes before additions', () => {
    assert.deepEqual(inventoryDifferences([entry('a'), entry('b')], [entry('a'), entry('b')]), []);
    const reasons = inventoryDifferences([entry('a'), entry('b')], [entry('c'), entry('b', 'c')]);
    assert.deepEqual(
      reasons.map((reason) => reason.code),
      ['FILE_REMOVED', 'FILE_CHANGED', 'FILE_ADDED'],
    );
  });
});

describe('readAssemblyListing', () => {
  it('lists every entry and reads the bytes of the regular files only', async () => {
    const files = new MemoryAssemblyFileSystem();
    await files.createFile(`${DIR}/a/x.json`, encoder.encode('{}'), 0o644);
    files.placeSpecial(`${DIR}/link`, 'symlink');
    const listed = await readAssemblyListing(files, DIR);
    assert.ok(listed.ok);
    assert.deepEqual(
      listed.value.entries.map((item) => [item.path, item.type]),
      [
        ['a', 'directory'],
        ['a/x.json', 'file'],
        ['link', 'symlink'],
      ],
    );
    assert.deepEqual(listed.value.files, [{ path: 'a/x.json', bytes: encoder.encode('{}') }]);
  });

  it('reports a directory it cannot list or a file it cannot read', async () => {
    const files = new MemoryAssemblyFileSystem();
    const absent = await readAssemblyListing(files, DIR);
    assert.deepEqual(absent.ok ? [] : absent.error.map((reason) => reason.code), ['ASSEMBLY_UNREADABLE']);
    assert.match(
      absent.ok ? '' : (absent.error[0]?.detail ?? ''),
      /^NOT_FOUND: .*; expected a readable assembly directory$/,
    );
    await files.createFile(`${DIR}/x.json`, encoder.encode('{}'), 0o644);
    files.failRead(`${DIR}/x.json`);
    const unread = await readAssemblyListing(files, DIR);
    assert.match(
      unread.ok ? '' : (unread.error[0]?.detail ?? ''),
      /^IO_ERROR: .*; expected the bytes of every regular file$/,
    );
  });
});
