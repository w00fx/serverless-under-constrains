// The re-verification of a frozen assembly (BR-RUA-042; D-25; design §12.5): for any two inventory
// file lists, the differences are empty exactly when the lists hold the same files, there is one
// reason per added, removed or changed path, and the capped verification lists at most 20 of them
// plus one count. Configuration readings are checked the same way: unique per attribute, sorted.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { inventoryDifferences } from '../../../src/deployment-assembly/assembly-verification.ts';
import { checkConfiguration } from '../../../src/deployment-assembly/provisioning-readings.ts';
import type { JsonValue, Sha256Hex } from '../../../src/record-contract/primitives.ts';
import type { AssemblyFileEntry } from '../../../src/record-contract/records/group-a/deployment_assembly_inventory.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const entryArbitrary: fc.Arbitrary<AssemblyFileEntry> = fc.record({
  path: fc.constantFrom(
    'manifest.json',
    'a.template.json',
    'asset.1/index.mjs',
    'asset.2/index.mjs',
    'read.1.1.lock',
    'tree.json',
  ),
  bytes: fc.integer({ min: 0, max: 3 }),
  mode: fc.constantFrom('0644', '0755'),
  sha256: fc.constantFrom('a', 'b').map((digit) => digit.repeat(64) as Sha256Hex),
});
const listArbitrary = fc.uniqueArray(entryArbitrary, { selector: (entry) => entry.path, maxLength: 6 });

function byPath(entries: readonly AssemblyFileEntry[]): ReadonlyMap<string, string> {
  return new Map(entries.map((entry) => [entry.path, JSON.stringify(entry)]));
}

describe('inventoryDifferences', () => {
  it('is empty exactly for the same files and has one reason per differing path (property)', () => {
    fc.assert(
      fc.property(listArbitrary, listArbitrary, (expected, actual) => {
        const reasons = inventoryDifferences(expected, actual);
        const before = byPath(expected);
        const now = byPath(actual);
        const differing = new Set(
          [...before.keys(), ...now.keys()].filter((path) => before.get(path) !== now.get(path)),
        );
        assert.equal(reasons.length, differing.size);
        assert.equal(reasons.length === 0, differing.size === 0);
        assert.ok(reasons.every((reason) => ['FILE_ADDED', 'FILE_REMOVED', 'FILE_CHANGED'].includes(reason.code)));
      }),
      fuzzParameters(),
    );
  });
});

describe('checkConfiguration', () => {
  it('keeps one canonical entry per attribute, sorted, and a reason for every other reading (property)', () => {
    const reading = fc.record({
      logical_id: fc.constantFrom('A', 'AB', 'B', 'bad-id'),
      attribute_path: fc.constantFrom('X', 'X.Y', 'Z', '.'),
      value: fc.jsonValue({ maxDepth: 2 }) as fc.Arbitrary<JsonValue>,
    });
    fc.assert(
      fc.property(fc.array(reading, { maxLength: 8 }), (readings) => {
        const checked = checkConfiguration(readings);
        const keys = checked.entries.map((entry) => [entry.logical_id, entry.attribute_path] as const);
        assert.equal(new Set(keys.map((key) => key.join('\u0000'))).size, keys.length);
        const sorted = keys.toSorted((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
        assert.deepEqual(keys, sorted);
        const repeatsOfKept = readings.filter((item) =>
          keys.some(([id, path]) => id === item.logical_id && path === item.attribute_path),
        ).length;
        assert.ok(checked.reasons.length + repeatsOfKept >= readings.length);
      }),
      fuzzParameters(),
    );
  });
});
