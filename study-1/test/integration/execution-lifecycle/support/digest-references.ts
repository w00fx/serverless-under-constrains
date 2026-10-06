// Every execution-manifest digest a package's records name (AC-RUA-008 "every result references
// those exact frozen bytes"): the `execution_manifest_sha256` of each JSON record and JSONL event,
// and the `owner_manifest_sha256` of each lease event, wherever they sit in the record.

const DIGEST_FIELDS: ReadonlySet<string> = new Set(['execution_manifest_sha256', 'owner_manifest_sha256']);

/**
 * The distinct manifest digests named anywhere in the JSON and JSONL files.
 *
 * @example
 * manifestDigestsNamed(cloud.packageFiles()); // Set { '03b2…' }
 */
export function manifestDigestsNamed(files: ReadonlyMap<string, Uint8Array>): ReadonlySet<string> {
  const found = new Set<string>();
  for (const [path, bytes] of files) {
    if (!path.endsWith('.json') && !path.endsWith('.jsonl')) {
      continue;
    }
    const text = new TextDecoder().decode(bytes);
    const documents = path.endsWith('.jsonl') ? text.split('\n').filter((line) => line !== '') : [text];
    for (const document of documents) {
      collect(JSON.parse(document) as unknown, found);
    }
  }
  return found;
}

/**
 * How many package files name at least one manifest digest.
 *
 * @example
 * filesNamingADigest(files); // 31
 */
export function filesNamingADigest(files: ReadonlyMap<string, Uint8Array>): number {
  return [...files].filter(([path, bytes]) => manifestDigestsNamed(new Map([[path, bytes]])).size > 0).length;
}

function collect(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collect(item, found);
    }
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  for (const [key, member] of Object.entries(value)) {
    if (DIGEST_FIELDS.has(key) && typeof member === 'string') {
      found.add(member);
    }
    collect(member, found);
  }
}
