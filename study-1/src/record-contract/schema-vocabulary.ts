// Code-level rules of BR-RUA-033/035 that plain JSON Schema cannot state, registered on Ajv
// as formats and keywords so every record schema enforces them through `$defs`:
// - `utc-millis`: the timestamp pattern plus a Date round trip (rejects 2026-02-30);
// - `package-relative-path`: normalized POSIX path, no absolute path, no traversal, no NUL
//   character and no whitespace at either end;
// - `x-rua-ascending-unique`: causation ids lexicographically sorted and unique;
// - `x-rua-evidence-ref-order`: evidence references in canonical order without duplicates.
// It also replaces Ajv's built-in `uniqueItems` with a total comparison (see below).

import type { Ajv2020, FuncKeywordDefinition } from 'ajv/dist/2020.js';

import { isCanonicalCausation } from './envelope.ts';
import { classifyArtifactPath, compareEvidenceRefs, isOrderableEvidenceRef } from './evidence-refs.ts';
import type { EvidenceRef } from './evidence-refs.ts';
import { findDuplicateItems } from './json-value.ts';
import { isUtcMillis } from './timestamps.ts';

export const ASCENDING_UNIQUE_KEYWORD = 'x-rua-ascending-unique';
export const EVIDENCE_REF_ORDER_KEYWORD = 'x-rua-evidence-ref-order';
export const UNIQUE_ITEMS_KEYWORD = 'uniqueItems';

type UniqueItemsCheck = NonNullable<FuncKeywordDefinition['validate']>;

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
  // Ajv's built-in `uniqueItems` compares object items with fast-deep-equal, which calls an
  // item's own `valueOf` and throws on JSON such as `[{"valueOf":1},{"valueOf":1}]` or on
  // null-prototype objects (Owner amendment A-02 audit). The shared `causation_ids` and many
  // catalogue arrays use it, so the kernel swaps in a total comparison that keeps the keyword
  // name, message and params Ajv reports.
  ajv.removeKeyword(UNIQUE_ITEMS_KEYWORD);
  ajv.addKeyword({ keyword: UNIQUE_ITEMS_KEYWORD, type: 'array', schemaType: 'boolean', validate: uniqueItemsCheck() });
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
  return items.length === 0 || isCanonicalCausation(items);
}

// Items that are not objects, or whose ordering members are not strings, are type errors that
// `items` reports; this keyword judges only the order of well-typed references (A-02).
function isCanonicalRefOrder(items: readonly unknown[]): boolean {
  if (!items.every(isOrderableEvidenceRef)) {
    return true;
  }
  let previous: EvidenceRef | undefined;
  for (const ref of items) {
    if (previous !== undefined && compareEvidenceRefs(previous, ref) >= 0) {
      return false;
    }
    previous = ref;
  }
  return true;
}

// One check per Ajv instance: Ajv reads `errors` off the function right after each call.
function uniqueItemsCheck(): UniqueItemsCheck {
  const check: UniqueItemsCheck = (enabled: boolean, items: readonly unknown[]): boolean => {
    const duplicate = enabled ? findDuplicateItems(items) : undefined;
    if (duplicate === undefined) {
      return true;
    }
    const { earlier: j, later: i } = duplicate;
    check.errors = [
      {
        keyword: UNIQUE_ITEMS_KEYWORD,
        message: `must NOT have duplicate items (items ## ${String(j)} and ${String(i)} are identical)`,
        params: { i, j },
      },
    ];
    return false;
  };
  return check;
}
