// The attempt-lifecycle suite minimums (design §12.1, D-33, Owner amendment A-03): the file
// exists and holds at least the cases §14 lists for this feature. §14 unit cases owned by
// WP-05: AC-RUA-016 (3), AC-RUA-028 (3; the fourth case belongs to WP-06), AC-RUA-043 (20
// table cells plus 12 refused pairs) and AC-RUA-045 (2), so 40. §12.5 lists one fuzz target
// (`foldEffectKnowledge`). The values only ratchet upward; that is a review rule, not a test.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(new URL('../../../quality/suite-minimums/attempt-lifecycle.json', import.meta.url));

describe('attempt-lifecycle suite minimums', () => {
  it('cover at least the §14 unit cases and the §12.5 fuzz target', () => {
    const minimums = parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
    assert.ok((minimums.unit ?? 0) >= 3 + 3 + 20 + 12 + 2, `unit minimum ${String(minimums.unit)}; expected >= 40`);
    assert.ok((minimums.fuzz ?? 0) >= 1, `fuzz minimum ${String(minimums.fuzz)}; expected >= 1`);
  });
});
