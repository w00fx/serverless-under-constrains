// The provider-client suite minimums (design §12.1, §14, D-33, Owner amendment A-03): the file
// exists and holds at least the §14 case counts of this feature: unit 7 (AC-RUA-015 one case,
// AC-RUA-028 one case, AC-RUA-044 five cases) and integration 1 (the §12.2 conformance of the
// named fakes). Each §14 case also exists under its exact name in its exact file, so a rename
// cannot silently drop a criterion's evidence. The committed values sit at the counts that
// exist today and only ratchet upward; that is a review rule, not a test.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(new URL('../../../quality/suite-minimums/provider-client.json', import.meta.url));

const SECTION_14_CASES: readonly (readonly [string, readonly string[]])[] = [
  ['pre-dispatch-failure.test.ts', ['ac015-failure-before-dispatch']],
  ['dispatch-boundary.test.ts', ['ambiguous-dispatch-transition-never-invokes-transport']],
  [
    'abort-error.test.ts',
    [
      'abort-before-3s',
      'transport-settles-first',
      'timeout-write-fails',
      'early-timer-fire-rearms',
      'late-settlement-not-parsed',
    ],
  ],
];

const SECTION_14_UNIT_CASES = SECTION_14_CASES.reduce((sum, [, cases]) => sum + cases.length, 0);

describe('provider-client suite minimums', () => {
  it('hold at least the §14 unit cases and one integration case', () => {
    const minimums = parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
    assert.equal(SECTION_14_UNIT_CASES, 7);
    assert.ok(
      (minimums.unit ?? 0) >= SECTION_14_UNIT_CASES,
      `unit minimum ${String(minimums.unit)}; expected >= ${String(SECTION_14_UNIT_CASES)}`,
    );
    assert.ok((minimums.integration ?? 0) >= 1, `integration minimum ${String(minimums.integration)}; expected >= 1`);
  });

  it('every §14 case is a test named exactly so in its file', () => {
    for (const [file, cases] of SECTION_14_CASES) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      for (const name of cases) {
        assert.ok(source.includes(`it('${name}`), `case ${name} not found in ${file}; expected it('${name}...')`);
      }
    }
  });
});
