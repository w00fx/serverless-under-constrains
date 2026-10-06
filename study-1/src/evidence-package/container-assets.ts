// Container-image assets in a cloud assembly (BR-RUA-042: "container-image assets are rejected by
// the PoC"; design §9.8 S3). CDK records them in two places: the `dockerImages` map of every
// `*.assets.json` asset manifest, and (legacy asset metadata) an `aws:cdk:asset` metadata entry
// with `packaging: "container-image"` in a `manifest.json`. Both files are parsed totally with
// the kernel parser and read through own properties only (A-05); a file that cannot be read as
// such a manifest is rejected too, because it cannot prove the absence of container assets.

import { boundedJsonText, isJsonArray, isJsonObject } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import type { JsonObject, JsonValue, StructuredReason } from '../record-contract/primitives.ts';
import type { PackageFile } from './package-file-system.ts';

const ASSET_MANIFEST_SUFFIX = '.assets.json';
const CLOUD_ASSEMBLY_MANIFEST = 'manifest.json';
const ASSET_METADATA_TYPE = 'aws:cdk:asset';
const CONTAINER_PACKAGING = 'container-image';

/**
 * Every reason the files of an assembly declare, or may declare, a container-image asset.
 *
 * @example
 * containerAssetFindings([{ path: 'Stack.assets.json', bytes }]); // [] when dockerImages is {}
 */
export function containerAssetFindings(files: readonly PackageFile[]): readonly StructuredReason[] {
  return files.flatMap((file) => {
    const name = file.path.slice(file.path.lastIndexOf('/') + 1);
    if (name.endsWith(ASSET_MANIFEST_SUFFIX)) {
      return assetManifestFindings(file);
    }
    return name === CLOUD_ASSEMBLY_MANIFEST ? cloudManifestFindings(file) : [];
  });
}

function assetManifestFindings(file: PackageFile): readonly StructuredReason[] {
  const manifest = readObject(file);
  if (!manifest.ok) {
    return [manifest.reason];
  }
  const images = ownMember(manifest.value, 'dockerImages');
  if (images === undefined || (isJsonObject(images) && Object.keys(images).length === 0)) {
    return [];
  }
  if (!isJsonObject(images)) {
    return [unreadable(file.path, `dockerImages is ${boundedJsonText(images)}; expected an object`)];
  }
  return [
    containerAsset(file.path, `dockerImages declares ${String(Object.keys(images).length)} image(s); expected none`),
  ];
}

function cloudManifestFindings(file: PackageFile): readonly StructuredReason[] {
  const manifest = readObject(file);
  if (!manifest.ok) {
    return [manifest.reason];
  }
  const artifacts = ownMember(manifest.value, 'artifacts');
  if (artifacts === undefined) {
    return [];
  }
  if (!isJsonObject(artifacts)) {
    return [unreadable(file.path, `artifacts is ${boundedJsonText(artifacts)}; expected an object`)];
  }
  const containerIds = Object.keys(artifacts).filter((id) => declaresContainerAsset(artifacts[id]));
  return containerIds.map((id) =>
    containerAsset(file.path, `artifact ${boundedJsonText(id)} has container-image asset metadata; expected none`),
  );
}

// metadata: { "<construct path>": [ { "type": "aws:cdk:asset", "data": { "packaging": ... } } ] }
function declaresContainerAsset(artifact: JsonValue | undefined): boolean {
  const metadata = isJsonObject(artifact) ? ownMember(artifact, 'metadata') : undefined;
  if (!isJsonObject(metadata)) {
    return false;
  }
  return Object.values(metadata).some((entries) => isJsonArray(entries) && entries.some(isContainerAssetEntry));
}

function isContainerAssetEntry(entry: JsonValue): boolean {
  if (!isJsonObject(entry) || ownMember(entry, 'type') !== ASSET_METADATA_TYPE) {
    return false;
  }
  const data = ownMember(entry, 'data');
  return isJsonObject(data) && ownMember(data, 'packaging') === CONTAINER_PACKAGING;
}

type ReadObject =
  { readonly ok: true; readonly value: JsonObject } | { readonly ok: false; readonly reason: StructuredReason };

function readObject(file: PackageFile): ReadObject {
  const parsed = parseJsonDocument(file.bytes);
  if (parsed.ok && isJsonObject(parsed.value)) {
    return { ok: true, value: parsed.value };
  }
  const shown = parsed.ok ? boundedJsonText(parsed.value) : 'not one UTF-8 JSON document';
  return { ok: false, reason: unreadable(file.path, `content is ${shown}; expected a JSON object`) };
}

function ownMember(object: JsonObject, key: string): JsonValue | undefined {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function unreadable(path: string, detail: string): StructuredReason {
  return {
    code: 'ASSET_MANIFEST_UNREADABLE',
    subject: 'BR-RUA-042',
    detail: `${boundedJsonText(path)}: ${detail}`,
  };
}

function containerAsset(path: string, detail: string): StructuredReason {
  return { code: 'CONTAINER_ASSET', subject: 'BR-RUA-042', detail: `${boundedJsonText(path)}: ${detail}` };
}
