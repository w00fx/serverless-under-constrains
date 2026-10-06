// AC-RUA-046 (group B) under Owner amendment A-05 §3: a group-B record holding a hostile value is
// judged, never thrown on. The 100,000-level array, deeper than any recursive renderer survives,
// is read once from JSON text by the kernel parser, the path untrusted bytes take, and then placed
// in each example. A non-finite number cannot pass that parser, but the Lambda Node runtime decodes
// `1e400` to Infinity with JSON.parse before any guard runs, so the validator must reject it too.
// Inherited member names are covered by closed-objects.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseJsonDocument } from '../../../../src/record-contract/parsing.ts';
import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import { GROUP_B_EXAMPLES } from './examples/group-b-examples.ts';
import { assertRejected, violationsOf } from '../../../support/record-contract/group-b-validation.ts';
import {
  leavesOf,
  objectAt,
  objectPathsOf,
  pointerOf,
  withValueAt,
} from '../../../support/record-contract/json-paths.ts';
import type { JsonPath } from '../../../support/record-contract/json-paths.ts';
import { toJson } from '../../../support/record-contract/record-builders.ts';

const EXAMPLES = GROUP_B_EXAMPLES.map((example) => ({ label: example.label, json: toJson(example.record) }));

const DEEP_LEVELS = 100_000;
// What JSON.parse('1e400'), JSON.parse('-1e400') and an arithmetic slip yield.
const NON_FINITE_NUMBERS = [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN];

/** The 100,000-level array `[[[...]]]`, read by the kernel parser. */
function deepArray(): JsonValue {
  const parsed = parseJsonDocument(new TextEncoder().encode(`${'['.repeat(DEEP_LEVELS)}${']'.repeat(DEEP_LEVELS)}`));
  assert.ok(parsed.ok, 'the kernel parser reads a 100,000-level array');
  return parsed.value;
}

/** Asserts `record` is rejected at `path` or below it (an array member fails at its items). */
function assertRejectedAtOrBelow(record: JsonValue, label: string, path: JsonPath): void {
  const pointer = pointerOf(path);
  const violations = violationsOf(record);
  const located = violations.some(
    (violation) => violation.startsWith(`${pointer} `) || violation.startsWith(`${pointer}/`),
  );
  assert.ok(located, `${label}: expected a violation at ${pointer}, got ${JSON.stringify(violations)}`);
}

/** The first member of every object of every example, as [label, json, member path]. */
function firstMemberSites(): readonly (readonly [string, JsonValue, JsonPath])[] {
  return EXAMPLES.flatMap(({ label, json }) =>
    objectPathsOf(json).flatMap((path) => {
      const [first] = Object.keys(objectAt(json, path));
      return first === undefined ? [] : [[label, json, [...path, first]] as const];
    }),
  );
}

describe('AC-RUA-046 hostile values over group B (A-05)', () => {
  it('a non-finite number at every numeric leaf is rejected at that leaf', () => {
    let governed = 0;
    for (const { label: example, json } of EXAMPLES) {
      const numeric = leavesOf(json).filter((leaf) => typeof leaf.value === 'number');
      governed += numeric.length;
      const cases = numeric.flatMap((leaf) => NON_FINITE_NUMBERS.map((value) => [leaf, value] as const));
      for (const [leaf, hostile] of cases) {
        const label = `${example}${pointerOf(leaf.path)} = ${String(hostile)}`;
        assertRejected(withValueAt(json, leaf.path, hostile), label, pointerOf(leaf.path));
      }
    }
    assert.equal(governed, 188);
  });

  it('a 100,000-level value added to any object is rejected as an unknown member', () => {
    const deep = deepArray();
    let checked = 0;
    for (const { label, json } of EXAMPLES) {
      for (const path of objectPathsOf(json)) {
        const record = withValueAt(json, [...path, 'x_deep'], deep);
        assertRejected(record, `${label}${pointerOf(path)}/x_deep`, `${pointerOf(path)} additionalProperties`);
        checked += 1;
      }
    }
    assert.equal(checked, 111);
  });

  it('a 100,000-level value in place of a member is rejected at that member', () => {
    const deep = deepArray();
    const sites = firstMemberSites();
    assert.equal(sites.length, 111);
    for (const [label, json, path] of sites) {
      assertRejectedAtOrBelow(withValueAt(json, path, deep), `${label}${pointerOf(path)} deep`, path);
    }
  });
});
