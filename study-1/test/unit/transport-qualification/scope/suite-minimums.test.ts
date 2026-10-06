// The transport-qualification scope suite minimums (design §12.1, §14, D-33, Owner amendment
// A-03): the file exists and holds at least the §14 case count of every suite this feature has.
// §14 row 051 names one case file for this feature,
// `integration/transport-qualification/scope/qualification-drift.integration.test.ts`, with the
// three AC-RUA-051 cases (`scoped-source-change`, `scoped-dependency-change`,
// `unrelated-oracle-change`), which set the integration floor; unit holds at least one.
//
// Values only ratchet upward (A-03), so the test pins the last ratified counts as a floor: a
// downward edit of the committed file fails here (WP-11 review round 1). Raise both together.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(
  new URL('../../../../quality/suite-minimums/transport-qualification-scope.json', import.meta.url),
);
const AC_RUA_051_FILE = fileURLToPath(
  new URL(
    '../../../integration/transport-qualification/scope/qualification-drift.integration.test.ts',
    import.meta.url,
  ),
);
const AC_RUA_051_CASES = ['scoped-source-change', 'scoped-dependency-change', 'unrelated-oracle-change'] as const;
/** The counts ratified at the WP-11 single-pass review (143 unit, 66 integration cases). */
const RATIFIED_FLOOR = { unit: 143, integration: 66 } as const;

describe('transport-qualification scope suite minimums', () => {
  it('hold at least the three §14 AC-RUA-051 integration cases and a positive unit minimum', () => {
    const minimums = parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
    assert.ok(
      (minimums.integration ?? 0) >= AC_RUA_051_CASES.length,
      `integration minimum ${String(minimums.integration)}; expected >= ${String(AC_RUA_051_CASES.length)}`,
    );
    assert.ok((minimums.unit ?? 0) >= 1, `unit minimum ${String(minimums.unit)}; expected >= 1`);
  });

  it('never fall below the last ratified counts (they only ratchet upward)', () => {
    const minimums = parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
    assert.ok(
      (minimums.unit ?? 0) >= RATIFIED_FLOOR.unit,
      `unit minimum ${String(minimums.unit)}; expected >= ${String(RATIFIED_FLOOR.unit)}`,
    );
    assert.ok(
      (minimums.integration ?? 0) >= RATIFIED_FLOOR.integration,
      `integration minimum ${String(minimums.integration)}; expected >= ${String(RATIFIED_FLOOR.integration)}`,
    );
  });

  it('keep the three AC-RUA-051 cases §14 traces in their case file', () => {
    const source = readFileSync(AC_RUA_051_FILE, 'utf8');
    for (const name of AC_RUA_051_CASES) {
      assert.ok(source.includes(`it('${name}',`), `AC-RUA-051 case ${name} missing from ${AC_RUA_051_FILE}`);
    }
  });
});
