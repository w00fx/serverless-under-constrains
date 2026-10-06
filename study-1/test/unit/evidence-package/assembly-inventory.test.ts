// The deployment-assembly inventory (BR-RUA-042; design §9.8 S3; RK-12): regular files only, in
// code-point order with permission digits and digests; symlinks, special files, container-image
// assets and bundles that import a bare `@aws-sdk/` specifier are rejected.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assemblyReason,
  compareCodePoints,
  inventoryAssembly,
  inventoryDigest,
  permissionDigits,
} from '../../../src/evidence-package/assembly-inventory.ts';
import type { AssemblyInventoryInput } from '../../../src/evidence-package/assembly-inventory.ts';
import { containerAssetFindings } from '../../../src/evidence-package/container-assets.ts';
import type { FsEntry, PackageFile } from '../../../src/evidence-package/package-file-system.ts';
import { canonicalJson } from '../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { DEEP_NESTING, towerText } from '../../support/kernel/deep-json.ts';
import { at } from '../../support/record-contract/record-builders.ts';
import { reasonCodes, textFile, utf8 } from '../../support/evidence-package/package-files.ts';

const validator = createRecordValidator();

function input(files: readonly PackageFile[], extra: readonly FsEntry[] = []): AssemblyInventoryInput {
  return {
    assembly_path: 'admission/deployment-assembly',
    entries: [...files.map((file) => ({ path: file.path, type: 'file' as const, mode: 0o100644 })), ...extra],
    files,
    inventoried_at: at(1),
  };
}

const MANIFEST = textFile(
  'manifest.json',
  '{"version":"48.0.0","artifacts":{"Stack":{"type":"aws:cloudformation:stack"}}}',
);
const BUNDLE = textFile('asset.1/index.mjs', 'const sdk = "bundled"; export { sdk };\n');

describe('inventoryAssembly', () => {
  it('lists regular files in code-point order with mode digits and digests', () => {
    const astral = textFile('\u{1F600}.txt', 'astral');
    const bmp = textFile('｡.txt', 'bmp');
    const built = inventoryAssembly(
      input([astral, MANIFEST, bmp, BUNDLE], [{ path: 'asset.1', type: 'directory', mode: 0o040755 }]),
    );
    assert.ok(built.ok);
    assert.deepEqual(
      built.value.files.map((file) => file.path),
      ['asset.1/index.mjs', 'manifest.json', '｡.txt', '\u{1F600}.txt'],
    );
    assert.deepEqual(built.value.files[1], {
      path: 'manifest.json',
      bytes: MANIFEST.bytes.length,
      mode: '0644',
      sha256: sha256Hex(MANIFEST.bytes),
    });
    assert.equal(
      built.value.inventory_sha256,
      sha256Hex(utf8(canonicalJson(built.value.files.map((file) => ({ ...file }))))),
    );
    assert.equal(inventoryDigest(built.value.files), built.value.inventory_sha256);
    assert.ok(
      validator.validateAs('deployment_assembly_inventory', JSON.parse(JSON.stringify(built.value)) as never).valid,
    );
  });

  it('rejects symlinks and special files, unread and unlisted files', () => {
    const built = inventoryAssembly({
      ...input(
        [MANIFEST],
        [
          { path: 'link', type: 'symlink', mode: 0o120777 },
          { path: 'pipe', type: 'fifo', mode: 0o010644 },
          { path: 'unread.json', type: 'file', mode: 0o100644 },
        ],
      ),
      files: [MANIFEST, textFile('unlisted.json', '{}')],
    });
    assert.ok(!built.ok);
    assert.deepEqual(reasonCodes(built.error), [
      'NON_REGULAR_FILE',
      'NON_REGULAR_FILE',
      'FILE_BYTES_MISSING',
      'FILE_NOT_LISTED',
    ]);
  });

  it('rejects invalid assembly and file paths and duplicate files', () => {
    const built = inventoryAssembly({
      ...input([MANIFEST, MANIFEST, textFile('../up.json', '{}')]),
      assembly_path: '/abs',
    });
    assert.ok(!built.ok);
    assert.deepEqual(reasonCodes(built.error), [
      'INVALID_ARTIFACT_PATH',
      'INVALID_ARTIFACT_PATH',
      'DUPLICATE_ARTIFACT_PATH',
    ]);
  });

  it('rejects an empty assembly', () => {
    const built = inventoryAssembly(input([]));
    assert.ok(!built.ok);
    assert.deepEqual(reasonCodes(built.error), ['EMPTY_ASSEMBLY']);
  });

  it('rejects a bundle that imports a bare @aws-sdk specifier, in every import form (RK-12)', () => {
    for (const source of [
      'import { S3 } from "@aws-sdk/client-s3";',
      "export * from '@aws-sdk/client-sqs';",
      'const m = await import ( "@aws-sdk/client-lambda" );',
      "const m = require('@aws-sdk/client-sts');",
      'import "@aws-sdk/side-effect";',
    ]) {
      const built = inventoryAssembly(input([MANIFEST, textFile('asset.1/index.mjs', source)]));
      assert.ok(!built.ok, source);
      assert.deepEqual(reasonCodes(built.error), ['BARE_AWS_SDK_IMPORT'], source);
    }
  });

  // Regression (A-14, found by WP-24 on 2026-10-06): every real synthesized bundle quotes SDK
  // loads inside its error messages, and the text scan refused them as imports, so admission
  // could inventory no real assembly. The first source is the SDK's message as esbuild emits it.
  it('accepts a bundle whose strings, templates, comments and regular expressions only quote an SDK load', () => {
    for (const source of [
      'throw new Error(`register the package by calling [require("@aws-sdk/signature-v4-crt");] or an ESM equivalent such as [import "@aws-sdk/signature-v4-crt";]`);',
      "throw new Error(\"calling [require('@aws-sdk/signature-v4a');] or [import '@aws-sdk/signature-v4a';]\");",
      'const hint = \'export * from "@aws-sdk/client-sqs"\';',
      '// const m = await import("@aws-sdk/client-lambda");',
      '/* import { S3 } from "@aws-sdk/client-s3"; */ export const a = 1;',
      'const set = /[from "@aws-sdk/]/u;',
      'client.require("@aws-sdk/client-sts");',
    ]) {
      const built = inventoryAssembly(input([MANIFEST, textFile('asset.1/index.mjs', source)]));
      assert.ok(built.ok, source);
    }
  });

  it("still rejects a real load next to a quoted one, and esbuild's __require form", () => {
    for (const source of [
      'throw new Error(`[require("@aws-sdk/x");]`);\nimport { S3 } from "@aws-sdk/client-s3";',
      'const re = /["`]/g;\nconst m = await import("@aws-sdk/client-lambda");',
      'const a = `${require("@aws-sdk/client-sts")}`;',
      'var sts = __require("@aws-sdk/client-sts");',
    ]) {
      const built = inventoryAssembly(input([MANIFEST, textFile('asset.1/index.mjs', source)]));
      assert.ok(!built.ok, source);
      assert.deepEqual(reasonCodes(built.error), ['BARE_AWS_SDK_IMPORT'], source);
    }
  });

  it('accepts a bundled SDK and a non-.mjs file that mentions the SDK', () => {
    const built = inventoryAssembly(
      input([
        MANIFEST,
        textFile('asset.1/index.mjs', '// bundled from node_modules/@aws-sdk/client-s3\n'),
        textFile('asset.2/index.js', 'require("@aws-sdk/x")'),
      ]),
    );
    assert.ok(built.ok);
  });
});

describe('container-image assets', () => {
  it('rejects docker images in an asset manifest and container-image asset metadata', () => {
    const assets = textFile('Stack.assets.json', '{"version":"48.0.0","dockerImages":{"abc":{}}}');
    const legacy = textFile(
      'manifest.json',
      '{"artifacts":{"Stack":{"metadata":{"/Stack/Fn":[{"type":"aws:cdk:asset","data":{"packaging":"container-image"}}]}}}}',
    );
    assert.deepEqual(reasonCodes(containerAssetFindings([assets, legacy])), ['CONTAINER_ASSET', 'CONTAINER_ASSET']);
    const built = inventoryAssembly(input([assets]));
    assert.ok(!built.ok);
  });

  it('accepts file assets and manifests without container assets', () => {
    const files = [
      textFile('Stack.assets.json', '{"files":{},"dockerImages":{}}'),
      textFile('Other.assets.json', '{"files":{}}'),
      textFile('manifest.json', '{"version":"48.0.0"}'),
      textFile(
        'nested/manifest.json',
        '{"artifacts":{"A":{},"B":{"metadata":[]},"C":{"metadata":{"/p":[1,{"type":"other"},{"type":"aws:cdk:asset","data":{"packaging":"file"}},{"type":"aws:cdk:asset","data":"zip"}]}},"D":{"metadata":{"/q":"text"}},"E":1}}',
      ),
    ];
    assert.deepEqual(containerAssetFindings(files), []);
  });

  it('rejects manifests that cannot prove the absence of container assets', () => {
    const files = [
      textFile('A.assets.json', '{"dockerImages":[]}'),
      textFile('B.assets.json', '[1]'),
      textFile('C.assets.json', '{"dockerImages":'),
      textFile('manifest.json', '{"artifacts":[]}'),
      textFile('x/manifest.json', '"text"'),
    ];
    assert.deepEqual(reasonCodes(containerAssetFindings(files)), Array(5).fill('ASSET_MANIFEST_UNREADABLE'));
  });

  it('is total over deep nesting, non-finite numbers and inherited names (A-05)', () => {
    const files = [
      textFile('deep.assets.json', `{"dockerImages":${towerText('object', DEEP_NESTING, '1')}}`),
      textFile('manifest.json', `{"artifacts":{"A":{"metadata":{"/p":[${towerText('mixed', DEEP_NESTING, '1')}]}}}}`),
      textFile('big.assets.json', '{"dockerImages":1e400}'),
      textFile('proto.assets.json', '{"__proto__":{"dockerImages":{"a":1}},"constructor":{}}'),
    ];
    assert.deepEqual(reasonCodes(containerAssetFindings(files)), ['CONTAINER_ASSET', 'ASSET_MANIFEST_UNREADABLE']);
  });
});

describe('inventory helpers', () => {
  it('orders by code point and formats permission digits', () => {
    assert.equal(compareCodePoints('a', 'a'), 0);
    assert.ok(compareCodePoints('a', 'ab') < 0);
    assert.ok(compareCodePoints('\u{1F600}', '｡') > 0);
    assert.ok(compareCodePoints('｡', '\u{1F600}') < 0);
    assert.ok(compareCodePoints('퟿', '') < 0);
    assert.ok(compareCodePoints('a', '\uD800') < 0);
    assert.equal(permissionDigits(0o100755), '0755');
    assert.equal(permissionDigits(0o104755), '4755');
    assert.deepEqual(assemblyReason('X', 'd'), { code: 'X', subject: 'BR-RUA-042', detail: 'd' });
  });
});
