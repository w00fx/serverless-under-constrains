// The CAP-RUA formats and keywords registered on Ajv (BR-RUA-033, BR-RUA-035).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

import {
  ASCENDING_UNIQUE_KEYWORD,
  EVIDENCE_REF_ORDER_KEYWORD,
  UNIQUE_ITEMS_KEYWORD,
  isPackageRelativePath,
  registerRecordVocabulary,
} from '../../../src/record-contract/schema-vocabulary.ts';

function strictAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  registerRecordVocabulary(ajv);
  return ajv;
}

/** WP-03's minimized counterexample (Owner amendment A-02): JSON with no primitive conversion. */
const hostile = (): unknown => JSON.parse('{"toString":1,"valueOf":1}') as unknown;

const ref = (path: string, digit: string): { artifact_path: string; artifact_sha256: string } => ({
  artifact_path: path,
  artifact_sha256: digit.repeat(64),
});

describe('schema vocabulary', () => {
  it('names the custom keywords', () => {
    assert.equal(ASCENDING_UNIQUE_KEYWORD, 'x-rua-ascending-unique');
    assert.equal(EVIDENCE_REF_ORDER_KEYWORD, 'x-rua-evidence-ref-order');
  });

  it('validates utc-millis with the calendar round trip', () => {
    const check = strictAjv().compile({ type: 'string', format: 'utc-millis' });
    assert.equal(check('2026-10-05T12:00:00.000Z'), true);
    assert.equal(check('2026-02-30T12:00:00.000Z'), false);
    assert.equal(check('2026-10-05T12:00:00Z'), false);
  });

  it('validates package-relative paths', () => {
    const check = strictAjv().compile({ type: 'string', format: 'package-relative-path' });
    assert.equal(check('journal/events.jsonl'), true);
    for (const bad of ['', '/abs', '../up', 'a//b', 'a\\b', 'C:/x']) {
      assert.equal(check(bad), false, bad);
    }
    assert.equal(isPackageRelativePath('a/b.json'), true);
    assert.equal(isPackageRelativePath(''), false);
    assert.equal(isPackageRelativePath('./a'), false);
  });

  it('refuses package-relative paths with a NUL character or whitespace at either end', () => {
    const check = strictAjv().compile({ type: 'string', format: 'package-relative-path' });
    for (const bad of ['a\u0000b', 'a/b.json\u0000', ' a/b.json', 'a/b.json ', '\ta', 'a\r\n', '\u2028a', 'a\u00a0']) {
      assert.equal(check(bad), false, JSON.stringify(bad));
      assert.equal(isPackageRelativePath(bad), false, JSON.stringify(bad));
    }
    assert.equal(check('ledger/ledger snapshot.json'), true);
    assert.equal(isPackageRelativePath('ledger/ledger snapshot.json'), true);
  });

  it('enforces strictly ascending string arrays when enabled', () => {
    const ajv = strictAjv();
    const check = ajv.compile({ type: 'array', [ASCENDING_UNIQUE_KEYWORD]: true });
    assert.equal(check([]), true);
    assert.equal(check(['a', 'b']), true);
    assert.equal(check(['b', 'a']), false);
    assert.equal(check(['a', 'a']), false);
    assert.equal(check(['a', 1]), false);
    const disabled = ajv.compile({ type: 'array', [ASCENDING_UNIQUE_KEYWORD]: false });
    assert.equal(disabled(['b', 'a']), true);
  });

  it('enforces canonical evidence reference order when enabled', () => {
    const ajv = strictAjv();
    const check = ajv.compile({ type: 'array', [EVIDENCE_REF_ORDER_KEYWORD]: true });
    assert.equal(check([]), true);
    assert.equal(check([ref('a.json', 'a'), ref('b.json', 'a')]), true);
    assert.equal(check([ref('b.json', 'a'), ref('a.json', 'a')]), false);
    assert.equal(check([ref('a.json', 'a'), ref('a.json', 'a')]), false);
    assert.equal(check([ref('a.json', 'a'), 'not an object']), true, 'non-object items are left to `items`');
    assert.equal(check([ref('a.json', 'a'), null]), true, 'null items are left to `items`');
    const disabled = ajv.compile({ type: 'array', [EVIDENCE_REF_ORDER_KEYWORD]: false });
    assert.equal(disabled([ref('b.json', 'a'), ref('a.json', 'a')]), true);
  });

  it('leaves a non-string ordering member to `items` instead of throwing (A-02 regression)', () => {
    const check = strictAjv().compile({ type: 'array', [EVIDENCE_REF_ORDER_KEYWORD]: true });
    const members = ['artifact_path', 'artifact_sha256', 'event_id', 'json_pointer', 'package_index_sha256'];
    for (const member of members) {
      for (const value of [hostile(), Object.create(null) as unknown, 7, null, ['x'], {}]) {
        const later = { ...ref('b.json', 'a'), [member]: value };
        assert.equal(check([ref('a.json', 'a'), later]), true, `${member} on the second item`);
        assert.equal(check([later, ref('a.json', 'a')]), true, `${member} on the first item`);
      }
    }
    assert.equal(check([ref('a.json', 'a'), ['an', 'array']]), true, 'array items are left to `items`');
    assert.equal(check([{}, {}]), false, 'two references with every member absent are equal, so out of order');
  });

  it('replaces the built-in uniqueItems with the keyword name and error Ajv reports', () => {
    const ajv = strictAjv();
    const check = ajv.compile({ type: 'array', [UNIQUE_ITEMS_KEYWORD]: true });
    assert.equal(UNIQUE_ITEMS_KEYWORD, 'uniqueItems');
    assert.equal(check([]), true);
    assert.equal(check(['a', 'b', 1, '1', [], {}]), true);
    assert.equal(check(['a', 'b', 'a']), false);
    assert.deepEqual(check.errors, [
      {
        instancePath: '',
        schemaPath: '#/uniqueItems',
        keyword: 'uniqueItems',
        message: 'must NOT have duplicate items (items ## 0 and 2 are identical)',
        params: { i: 2, j: 0 },
      },
    ]);
    assert.equal(check([{ a: [1] }, { a: [1] }]), false);
    assert.equal(check.errors[0]?.message, 'must NOT have duplicate items (items ## 0 and 1 are identical)');
    const disabled = ajv.compile({ type: 'array', [UNIQUE_ITEMS_KEYWORD]: false });
    assert.equal(disabled(['a', 'a']), true);
  });

  it('judges uniqueItems totally over hostile and null-prototype items (A-02 audit regression)', () => {
    const ajv = strictAjv();
    const objects = ajv.compile({ type: 'array', items: { type: 'object' }, [UNIQUE_ITEMS_KEYWORD]: true });
    assert.equal(objects([hostile(), hostile()]), false);
    assert.deepEqual(objects.errors?.[0]?.params, { i: 1, j: 0 });
    assert.equal(objects([Object.create(null) as unknown, Object.create(null) as unknown]), false);
    assert.equal(objects([{ inner: hostile() }, { inner: { toString: 1, valueOf: 2 } }]), true);
    const strings = ajv.compile({ type: 'array', items: { type: 'string' }, [UNIQUE_ITEMS_KEYWORD]: true });
    assert.equal(strings([hostile(), hostile()]), false, 'the wrong-typed items fail `items` without a crash');
    assert.deepEqual(
      strings.errors?.map((error) => `${error.instancePath} ${error.keyword}`),
      ['/0 type', '/1 type', ' uniqueItems'],
    );
  });

  it('checks causation order totally, leaving no hostile item uncompared (A-02 audit regression)', () => {
    const check = strictAjv().compile({ type: 'array', [ASCENDING_UNIQUE_KEYWORD]: true });
    assert.equal(check([hostile()]), false);
    assert.equal(check(['a', hostile()]), false);
    assert.equal(check([hostile(), 'a']), false);
    assert.equal(check([Object.create(null) as unknown, 'a']), false);
  });
});
