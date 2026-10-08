// The treatment-controller suite minimums (design §12.1, §14, D-33, Owner amendment A-03): the
// file exists and holds a positive minimum for every suite this feature has. §14 lists no
// treatment-controller case of its own (the package feeds AC-RUA-002, -021 and -053), so each
// floor is one; the committed values sit at the counts that exist today and only ratchet
// upward, which is a review rule.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(
  new URL('../../../quality/suite-minimums/treatment-controller.json', import.meta.url),
);

describe('treatment-controller suite minimums', () => {
  it('hold a positive unit, integration and fuzz minimum', () => {
    const minimums = parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
    assert.ok((minimums.unit ?? 0) >= 1, `unit minimum ${String(minimums.unit)}; expected >= 1`);
    assert.ok((minimums.integration ?? 0) >= 1, `integration minimum ${String(minimums.integration)}; expected >= 1`);
    assert.ok((minimums.fuzz ?? 0) >= 1, `fuzz minimum ${String(minimums.fuzz)}; expected >= 1`);
  });
});
