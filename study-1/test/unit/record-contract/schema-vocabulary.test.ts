// The CAP-RUA formats and keywords registered on Ajv (BR-RUA-033, BR-RUA-035).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

import {
  ASCENDING_UNIQUE_KEYWORD,
  EVIDENCE_REF_ORDER_KEYWORD,
  isPackageRelativePath,
  registerRecordVocabulary,
} from '../../../src/record-contract/schema-vocabulary.ts';

function strictAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  registerRecordVocabulary(ajv);
  return ajv;
}

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
});
