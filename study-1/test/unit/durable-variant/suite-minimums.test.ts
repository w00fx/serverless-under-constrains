// The durable-variant suite minimums (design §12.1, D-33, Owner amendment A-03): the feature file
// exists and holds a positive minimum for every suite this feature has (unit, integration and
// fuzz), and the construct's synth file holds its integration minimum (A-11). The committed values
// sit at the counts that exist today and only ratchet upward; that is a review rule, not a test.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';

function minimumsOf(name: string): Readonly<Record<string, number | undefined>> {
  const path = fileURLToPath(new URL(`../../../quality/suite-minimums/${name}.json`, import.meta.url));
  return parseSuiteMinimums(path, JSON.parse(readFileSync(path, 'utf8')));
}

describe('durable-variant suite minimums', () => {
  it('hold a positive minimum for the unit, integration and fuzz suites', () => {
    const minimums = minimumsOf('durable-variant');
    assert.ok((minimums['unit'] ?? 0) >= 1, `unit minimum ${String(minimums['unit'])}; expected >= 1`);
    assert.ok(
      (minimums['integration'] ?? 0) >= 1,
      `integration minimum ${String(minimums['integration'])}; expected >= 1`,
    );
    assert.ok((minimums['fuzz'] ?? 0) >= 1, `fuzz minimum ${String(minimums['fuzz'])}; expected >= 1`);
  });

  it('hold a positive integration minimum for the construct synthesis', () => {
    const minimums = minimumsOf('infra-durable-variant');
    assert.ok(
      (minimums['integration'] ?? 0) >= 1,
      `integration minimum ${String(minimums['integration'])}; expected >= 1`,
    );
  });
});
