// Deeply nested JSON parsed from bytes (WP-00 review round 1). JSON.parse accepts nesting far
// deeper than the call stack, so every kernel function that takes parsed JSON is checked against
// towers like these: 100,000 levels (the floor Owner amendment A-05 sets for every boundary,
// raised from 50,000 in review round 2) is about 200 KB of input, far past the ~2,500 levels
// where the former recursive code threw RangeError.

import fc from 'fast-check';

import { parseJsonDocument } from '../../../src/record-contract/parsing.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';

/** Nesting depth of the permanent deep-input regression cases. */
export const DEEP_NESTING = 100_000;

export type TowerShape = 'array' | 'object' | 'mixed';

const TOWER_BRACKETS: Readonly<Record<TowerShape, readonly [string, string]>> = {
  array: ['[', ']'],
  object: ['{"a":', '}'],
  mixed: ['[{"a":', '}]'],
};

/**
 * JSON text of `depth` nested levels around `leaf`: `[[[1]]]`, `{"a":{"a":1}}`, or for `mixed`
 * an array holding an object per level.
 *
 * @example
 * towerText('array', 3, '1'); // '[[[1]]]'
 * towerText('object', 2, 'null'); // '{"a":{"a":null}}'
 * towerText('mixed', 1, '2'); // '[{"a":2}]'
 */
export function towerText(shape: TowerShape, depth: number, leaf: string): string {
  const [open, close] = TOWER_BRACKETS[shape];
  return `${open.repeat(depth)}${leaf}${close.repeat(depth)}`;
}

/**
 * Parses JSON text from its UTF-8 bytes through the kernel parser, as evidence ingestion does,
 * and throws when the text is not a JSON document (a broken fixture, not a finding).
 *
 * @example
 * parsedJson('{"a":[1]}'); // { a: [1] }
 */
export function parsedJson(text: string): JsonValue {
  const parsed = parseJsonDocument(new TextEncoder().encode(text));
  if (!parsed.ok) {
    throw new Error(
      `fixture of ${String(text.length)} characters is not JSON (${parsed.error.kind}); expected a document`,
    );
  }
  return parsed.value;
}

/**
 * A parsed tower of `depth` containers around the number 1.
 *
 * @example
 * const deep = parsedTower('object', DEEP_NESTING);
 */
export function parsedTower(shape: TowerShape, depth: number = DEEP_NESTING): JsonValue {
  return parsedJson(towerText(shape, depth, '1'));
}

/**
 * Fuzz values nested past the call stack: towers of 2,500 (where the recursive kernel code
 * first threw) to `maxDepth` levels of every shape around a small JSON leaf, parsed from bytes.
 *
 * @example
 * fc.oneof({ arbitrary: fc.jsonValue(), weight: 49 }, { arbitrary: deepTowerArbitrary(), weight: 1 });
 */
export function deepTowerArbitrary(maxDepth = 20_000): fc.Arbitrary<JsonValue> {
  return fc
    .record({
      shape: fc.constantFrom<TowerShape>('array', 'object', 'mixed'),
      depth: fc.integer({ min: 2_500, max: maxDepth }),
      leaf: fc.jsonValue({ maxDepth: 1 }),
    })
    .map(({ shape, depth, leaf }) => parsedJson(towerText(shape, depth, JSON.stringify(leaf))));
}
