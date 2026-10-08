// The event-journal suite minimums (design §12.1, D-33, Owner amendment A-03): the file exists
// and holds a minimum for every suite this feature has. §14 maps no acceptance criterion to
// event-journal, so the floor is one case per suite: unit (BR-RUA-033 append semantics),
// integration (the §12.2 conformance test of `MemoryAppendOnlyFile` and the real file system)
// and fuzz (the writer state machine, testing rule 6). The committed values sit at the counts
// that exist today and only ratchet upward; that is a review rule, not a test.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(new URL('../../../quality/suite-minimums/event-journal.json', import.meta.url));

describe('event-journal suite minimums', () => {
  it('hold a positive minimum for the unit, integration and fuzz suites', () => {
    const minimums = parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
    assert.ok((minimums.unit ?? 0) >= 1, `unit minimum ${String(minimums.unit)}; expected >= 1`);
    assert.ok((minimums.integration ?? 0) >= 1, `integration minimum ${String(minimums.integration)}; expected >= 1`);
    assert.ok((minimums.fuzz ?? 0) >= 1, `fuzz minimum ${String(minimums.fuzz)}; expected >= 1`);
  });
});
