// The shape of a frozen evidence package, as the golden shape-parity tests compare it with the
// golden builder's base fixtures (design §12.4): per file, the field set of each record type, and
// per journal, how many source instances each source has.

import type { JsonObject } from '../../../../src/record-contract/primitives.ts';
import { textField } from './frozen-trial-files.ts';

const decoder = new TextDecoder();

/** Package files keyed by package-relative path. */
export type PackageFiles = ReadonlyMap<string, Uint8Array>;

/** The records of a JSON file or the events of a JSONL journal. */
export function packageRecords(bytes: Uint8Array): readonly JsonObject[] {
  return decoder
    .decode(bytes)
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonObject);
}

/**
 * Per file of `directory`, except those ending in an `excluded` suffix: record type -> the sorted
 * union of its field names.
 */
export function fieldShape(
  files: PackageFiles,
  directory: string,
  excluded: readonly string[],
): Readonly<Record<string, Readonly<Record<string, string>>>> {
  const shape: Record<string, Record<string, string>> = {};
  for (const [path, bytes] of files) {
    if (!path.startsWith(`${directory}/`) || excluded.some((suffix) => path.endsWith(suffix))) {
      continue;
    }
    const byType = new Map<string, Set<string>>();
    for (const record of packageRecords(bytes)) {
      const type = textField(record, 'record_type');
      byType.set(type, new Set([...(byType.get(type) ?? []), ...Object.keys(record)]));
    }
    shape[path.slice(directory.length + 1)] = Object.fromEntries(
      [...byType]
        .toSorted(([a], [b]) => (a < b ? -1 : 1))
        .map(([type, fields]) => [type, [...fields].sort().join(',')]),
    );
  }
  return shape;
}

/** Per journal file of `directory`: source -> number of source instances. */
export function sourceStructure(files: PackageFiles, directory: string): Readonly<Record<string, string>> {
  const structure: Record<string, string> = {};
  for (const [path, bytes] of files) {
    if (!path.startsWith(`${directory}/journals/`)) {
      continue;
    }
    const instances = new Map<string, Set<string>>();
    for (const event of packageRecords(bytes)) {
      const source = textField(event, 'source');
      instances.set(source, new Set([...(instances.get(source) ?? []), textField(event, 'source_instance_id')]));
    }
    structure[path] = [...instances]
      .map(([source, ids]) => `${source}:${String(ids.size)}`)
      .sort()
      .join(',');
  }
  return structure;
}
