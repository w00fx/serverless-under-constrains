// Code-level rules of BR-RUA-033/035 that plain JSON Schema cannot state, registered on Ajv
// as formats and keywords so every record schema enforces them through `$defs`:
// - `utc-millis`: the timestamp pattern plus a Date round trip (rejects 2026-02-30);
// - `package-relative-path`: normalized POSIX path, no absolute path, no traversal;
// - `x-rua-ascending-unique`: causation ids lexicographically sorted and unique;
// - `x-rua-evidence-ref-order`: evidence references in canonical order without duplicates.

import type { Ajv2020 } from 'ajv/dist/2020.js';

import { isCanonicalCausation } from './envelope.ts';
import { classifyArtifactPath, compareEvidenceRefs } from './evidence-refs.ts';
import type { EvidenceRef } from './evidence-refs.ts';
import { isUtcMillis } from './timestamps.ts';

export const ASCENDING_UNIQUE_KEYWORD = 'x-rua-ascending-unique';
export const EVIDENCE_REF_ORDER_KEYWORD = 'x-rua-evidence-ref-order';

/**
 * Registers the CAP-RUA formats and keywords on an Ajv 2020-12 instance before any schema
 * is added (strict mode rejects unknown keywords and formats).
 *
 * @example
 * const ajv = new Ajv2020({ strict: true, allErrors: true });
 * registerRecordVocabulary(ajv);
 */
export function registerRecordVocabulary(ajv: Ajv2020): void {
  ajv.addFormat('utc-millis', { type: 'string', validate: isUtcMillis });
  ajv.addFormat('package-relative-path', { type: 'string', validate: isPackageRelativePath });
  ajv.addKeyword({
    keyword: ASCENDING_UNIQUE_KEYWORD,
    type: 'array',
    schemaType: 'boolean',
    errors: false,
    validate: (enabled: boolean, items: readonly unknown[]) => !enabled || isAscendingStrings(items),
  });
  ajv.addKeyword({
    keyword: EVIDENCE_REF_ORDER_KEYWORD,
    type: 'array',
    schemaType: 'boolean',
    errors: false,
    validate: (enabled: boolean, items: readonly unknown[]) => !enabled || isCanonicalRefOrder(items),
  });
}

/**
 * Tells whether a string is a normalized package-relative POSIX path (BR-RUA-035).
 *
 * @example
 * isPackageRelativePath('ledger/ledger-snapshot.json'); // true
 * isPackageRelativePath('../escape.json'); // false
 */
export function isPackageRelativePath(path: string): boolean {
  return path !== '' && classifyArtifactPath(path) === undefined;
}

// An empty array satisfies the keyword; `minItems` owns the non-empty rule.
function isAscendingStrings(items: readonly unknown[]): boolean {
  if (items.length === 0) {
    return true;
  }
  return items.every((item) => typeof item === 'string') && isCanonicalCausation(items);
}

// Items that are not objects are reported by `items`; this keyword judges only the order.
function isCanonicalRefOrder(items: readonly unknown[]): boolean {
  if (!items.every((item) => typeof item === 'object' && item !== null)) {
    return true;
  }
  let previous: EvidenceRef | undefined;
  for (const ref of items as readonly EvidenceRef[]) {
    if (previous !== undefined && compareEvidenceRefs(previous, ref) >= 0) {
      return false;
    }
    previous = ref;
  }
  return true;
}
