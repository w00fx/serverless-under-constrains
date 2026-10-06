// The verified temporary deploy copy (design §9.8 D1; D-25; BR-RUA-042; RK-13): only an intact
// inventory is copied, only into an absent or empty directory, exactly the inventoried regular
// files with their permission bits, and the copy must re-inventory equal to the frozen inventory.
// Every failure is a list of reasons and yields no VerifiedDeployCopy.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { prepareVerifiedDeployCopy } from '../../../src/deployment-assembly/deploy-copy.ts';
import { inventoryDigest } from '../../../src/evidence-package/assembly-inventory.ts';
import type { Sha256Hex } from '../../../src/record-contract/primitives.ts';
import type { DeploymentAssemblyInventory } from '../../../src/record-contract/records/group-a/deployment_assembly_inventory.ts';
import {
  ASSEMBLY_FILES,
  frozenInventory,
  placeAssembly,
} from '../../support/deployment-assembly/deployment-fixtures.ts';
import { MemoryAssemblyFileSystem } from '../../support/deployment-assembly/memory-assembly-file-system.ts';

const FROZEN = '/pkg/admission/deployment-assembly';
const COPY = '/study/.deploy-staging/3f1c2a9e';

interface CopyRig {
  readonly files: MemoryAssemblyFileSystem;
  readonly inventory: DeploymentAssemblyInventory;
}

async function rig(): Promise<CopyRig> {
  const files = new MemoryAssemblyFileSystem();
  await placeAssembly(files, FROZEN);
  return { files, inventory: await frozenInventory(files, FROZEN) };
}

function reasonCodes(result: Awaited<ReturnType<typeof prepareVerifiedDeployCopy>>): readonly string[] {
  return result.ok ? [] : result.error.map((reason) => reason.code);
}

describe('prepareVerifiedDeployCopy (D1)', () => {
  it('copies exactly the inventoried files with their modes and brands the verified copy', async () => {
    const { files, inventory } = await rig();
    const copy = await prepareVerifiedDeployCopy(FROZEN, inventory, COPY, files);
    assert.deepEqual(copy, { ok: true, value: { dir: COPY, inventory_sha256: inventory.inventory_sha256 } });
    assert.deepEqual((await frozenInventory(files, COPY)).files, inventory.files);
    const listed = await files.list(COPY);
    const modes = listed.ok
      ? listed.value.filter((entry) => entry.type === 'file').map((entry) => [entry.path, entry.mode & 0o7777])
      : [];
    assert.deepEqual(
      modes,
      ASSEMBLY_FILES.map((file) => [file.path, file.mode]).toSorted((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
    );
  });

  it('copies into an existing empty directory', async () => {
    const { files, inventory } = await rig();
    await files.createFile(`${COPY}/placeholder`, new Uint8Array(), 0o644);
    await files.removeFile(`${COPY}/placeholder`);
    assert.equal((await prepareVerifiedDeployCopy(FROZEN, inventory, COPY, files)).ok, true);
  });

  it('refuses a target that already holds entries, and copies nothing', async () => {
    const { files, inventory } = await rig();
    await files.createFile(`${COPY}/stale/read.1.1.lock`, new Uint8Array(), 0o644);
    const copy = await prepareVerifiedDeployCopy(FROZEN, inventory, COPY, files);
    assert.deepEqual(reasonCodes(copy), ['DEPLOY_COPY_NOT_EMPTY']);
    assert.match(
      copy.ok ? '' : (copy.error[0]?.detail ?? ''),
      /already holds 2 entries; expected an absent or empty directory/,
    );
    assert.equal((await files.read(`${COPY}/manifest.json`)).ok, false);
  });

  it('refuses a target it cannot list', async () => {
    const { files, inventory } = await rig();
    files.failList(COPY);
    assert.deepEqual(reasonCodes(await prepareVerifiedDeployCopy(FROZEN, inventory, COPY, files)), [
      'DEPLOY_COPY_UNREADABLE',
    ]);
  });

  it('refuses an inventory whose digest does not match its files, before touching the disk', async () => {
    const { files, inventory } = await rig();
    const tampered = { ...inventory, inventory_sha256: 'f'.repeat(64) as Sha256Hex };
    files.failList(COPY);
    const copy = await prepareVerifiedDeployCopy(FROZEN, tampered, COPY, files);
    assert.deepEqual(reasonCodes(copy), ['INVENTORY_DIGEST_MISMATCH']);
  });

  it('refuses a frozen directory it cannot list or a frozen file it cannot read', async () => {
    const unlisted = await rig();
    unlisted.files.failList(FROZEN);
    assert.deepEqual(reasonCodes(await prepareVerifiedDeployCopy(FROZEN, unlisted.inventory, COPY, unlisted.files)), [
      'FROZEN_ASSEMBLY_UNREADABLE',
    ]);
    const unread = await rig();
    unread.files.failRead(`${FROZEN}/manifest.json`);
    assert.deepEqual(reasonCodes(await prepareVerifiedDeployCopy(FROZEN, unread.inventory, COPY, unread.files)), [
      'FROZEN_ASSEMBLY_UNREADABLE',
    ]);
  });

  it('refuses an inventoried file that is absent or no longer a regular file', async () => {
    const absent = await rig();
    await absent.files.removeFile(`${FROZEN}/manifest.json`);
    const first = await prepareVerifiedDeployCopy(FROZEN, absent.inventory, COPY, absent.files);
    assert.deepEqual(reasonCodes(first), ['FROZEN_FILE_MISSING']);
    assert.match(first.ok ? '' : (first.error[0]?.detail ?? ''), /^"manifest\.json" is absent in the frozen assembly/);
    const linked = await rig();
    await linked.files.removeFile(`${FROZEN}/manifest.json`);
    linked.files.placeSpecial(`${FROZEN}/manifest.json`, 'symlink');
    const second = await prepareVerifiedDeployCopy(FROZEN, linked.inventory, COPY, linked.files);
    assert.match(
      second.ok ? '' : (second.error[0]?.detail ?? ''),
      /^"manifest\.json" is a symlink in the frozen assembly; expected a regular file$/,
    );
  });

  it('refuses an inventoried path that is not a normalized relative path', async () => {
    const { files, inventory } = await rig();
    const [first, ...rest] = inventory.files;
    const escaping = [
      { ...first, path: '../outside.json' },
      ...rest,
    ] as unknown as DeploymentAssemblyInventory['files'];
    const forged = { ...inventory, files: escaping, inventory_sha256: inventoryDigest(escaping) };
    assert.deepEqual(reasonCodes(await prepareVerifiedDeployCopy(FROZEN, forged, COPY, files)), [
      'INVENTORY_PATH_INVALID',
    ]);
  });

  it('reports a copy it cannot write', async () => {
    const { files, inventory } = await rig();
    files.failCreate(`${COPY}/manifest.json`);
    assert.deepEqual(reasonCodes(await prepareVerifiedDeployCopy(FROZEN, inventory, COPY, files)), [
      'DEPLOY_COPY_WRITE_FAILED',
    ]);
  });

  it('refuses a copy that differs from the inventory because the frozen bytes or mode changed', async () => {
    const changed = await rig();
    changed.files.corrupt(`${FROZEN}/asset.abc123/index.mjs`);
    const first = await prepareVerifiedDeployCopy(FROZEN, changed.inventory, COPY, changed.files);
    assert.deepEqual(reasonCodes(first), ['DEPLOY_COPY_NOT_VERIFIED', 'FILE_CHANGED']);
    assert.match(
      first.ok ? '' : (first.error[1]?.detail ?? ''),
      /^"asset\.abc123\/index\.mjs" has sha256 [0-9a-f]{64} \(frozen [0-9a-f]{64}\);/,
    );
    const remoded = await rig();
    remoded.files.setMode(`${FROZEN}/asset.abc123/run.sh`, 0o700);
    const second = await prepareVerifiedDeployCopy(FROZEN, remoded.inventory, COPY, remoded.files);
    assert.match(
      second.ok ? '' : (second.error[1]?.detail ?? ''),
      /^"asset\.abc123\/run\.sh" has mode 0700 \(frozen 0755\);/,
    );
  });

  it('refuses a copy it cannot read back', async () => {
    const { files, inventory } = await rig();
    files.failRead(`${COPY}/manifest.json`);
    assert.deepEqual(reasonCodes(await prepareVerifiedDeployCopy(FROZEN, inventory, COPY, files)), [
      'ASSEMBLY_UNREADABLE',
    ]);
  });

  it('copies no file beyond the inventory', async () => {
    const { files, inventory } = await rig();
    await files.createFile(`${FROZEN}/read.99.1.lock`, new TextEncoder().encode('99'), 0o644);
    const copy = await prepareVerifiedDeployCopy(FROZEN, inventory, COPY, files);
    assert.equal(copy.ok, true);
    assert.equal((await files.read(`${COPY}/read.99.1.lock`)).ok, false);
  });
});
