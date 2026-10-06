// The golden builder's suite minimums (Owner amendment A-03): `tools/run-suite.ts` sums every
// `quality/suite-minimums/*.json`, so this feature's file must exist and declare the suites it
// owns, or a deleted test file would pass unnoticed.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';
import { STUDY_ROOT } from '../../golden/_harness/golden-harness.ts';

const SOURCE = 'quality/suite-minimums/golden-builder.json';

describe('golden builder suite minimums', () => {
  it('declares nonzero unit, golden and fuzz minimums', () => {
    const minimums = parseSuiteMinimums(SOURCE, JSON.parse(readFileSync(`${STUDY_ROOT}${SOURCE}`, 'utf8')));
    assert.deepEqual(Object.keys(minimums).sort(), ['fuzz', 'golden', 'unit']);
    assert.ok(Object.values(minimums).every((minimum) => minimum > 0));
  });
});
