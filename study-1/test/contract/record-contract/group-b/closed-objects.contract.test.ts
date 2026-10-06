// AC-RUA-046 (group B): every record object is closed (design §6 `additionalProperties: false`,
// Owner amendment A-07). Unknown members are rejected at every level, including the names
// `Object.prototype` defines: an evaluated-members map kept in a plain object reports those as
// already seen, which once let `toString` or `__proto__` through every group-B record root.
// The mutated records are written as JSON text and read back by the kernel parser, the path
// untrusted bytes take (A-05 §3: inherited-member names at every untrusted-input boundary).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isJsonObject } from '../../../../src/record-contract/json-value.ts';
import { parseJsonDocument } from '../../../../src/record-contract/parsing.ts';
import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import { RECORD_TYPE_GROUPS } from '../../../../src/record-contract/record-types.ts';
import { GROUP_B_EXAMPLES } from './examples/group-b-examples.ts';
import { assertRejected } from './support/group-b-validation.ts';
import { INHERITED_MEMBER_NAMES, objectAt, objectPathsOf, pointerOf, withValueAt } from './support/json-paths.ts';
import type { JsonPath } from './support/json-paths.ts';
import { toJson } from './support/record-builders.ts';
import { schemaOf } from './support/schema-reading.ts';

const EXAMPLES = GROUP_B_EXAMPLES.map((example) => ({ label: example.label, json: toJson(example.record) }));

// The names the round-2 review found accepted at every group-B root (verify/eng-r2-inherited-*).
const REPORTED_NAMES = [
  '__proto__',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
];

/** `json` with one member added at `path`, serialized to text and parsed back by the kernel. */
function parsedWithMember(json: JsonValue, path: JsonPath, name: string): JsonValue {
  const text = JSON.stringify(withValueAt(json, [...path, name], 1));
  const parsed = parseJsonDocument(new TextEncoder().encode(text));
  assert.ok(parsed.ok, `${pointerOf(path)}/${name} parses`);
  assert.ok(Object.hasOwn(objectAt(parsed.value, path), name), `${pointerOf(path)}/${name} is an own member`);
  return parsed.value;
}

/** Every key named `keyword` anywhere in a schema, as JSON Pointers. */
function keywordSites(node: JsonValue, keyword: string, pointer = ''): readonly string[] {
  if (Array.isArray(node)) {
    return node.flatMap((child: JsonValue, index) => keywordSites(child, keyword, `${pointer}/${String(index)}`));
  }
  if (!isJsonObject(node)) {
    return [];
  }
  return Object.entries(node).flatMap(([key, child]) => [
    ...(key === keyword ? [`${pointer}/${key}`] : []),
    ...keywordSites(child, keyword, `${pointer}/${key}`),
  ]);
}

describe('AC-RUA-046 closed records over group B', () => {
  it('names every Object.prototype member the review reported', () => {
    for (const name of REPORTED_NAMES) {
      assert.ok(INHERITED_MEMBER_NAMES.includes(name), name);
    }
  });

  it('every object rejects each inherited Object.prototype name as an unknown member', () => {
    const sites = EXAMPLES.flatMap(({ label, json }) => objectPathsOf(json).map((path) => ({ label, json, path })));
    assert.equal(sites.length, 111);
    for (const { label, json, path } of sites) {
      for (const name of INHERITED_MEMBER_NAMES) {
        const where = `${label}${pointerOf(path)}/${name}`;
        assertRejected(parsedWithMember(json, path, name), where, `${pointerOf(path)} additionalProperties`);
      }
    }
  });

  it('every schema closes its root with additionalProperties and never relies on unevaluatedProperties', () => {
    for (const recordType of RECORD_TYPE_GROUPS['group-b']) {
      const schema = schemaOf(recordType);
      assert.ok(isJsonObject(schema) && schema['additionalProperties'] === false, `${recordType} root closure`);
      assert.deepEqual(keywordSites(schema, 'unevaluatedProperties'), [], recordType);
    }
  });
});
