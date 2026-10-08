// The coordination-lease suite minimums (design §12.1, D-33, Owner amendment A-03): the files
// exist and hold a minimum for every suite this feature has. §14 maps AC-RUA-023 and AC-RUA-033
// to integration cases of this feature (`recovery-before-stale-boundary-resumes`;
// `ownership-mismatch`, `stale-past-300s`, `ttl-expiry-is-not-release`), so its integration
// minimum is at least those four; unit (the lease layout, store adapter, health machine and
// session) and fuzz (decoder totality and the health and session state machines, testing rule
// 6) are at least one. The coordination stack's synthesis cases have their own file (A-11).
// The committed values sit at the counts that exist today and only ratchet upward; that is a
// review rule, not a test.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';

function minimumsOf(name: string): ReturnType<typeof parseSuiteMinimums> {
  const path = fileURLToPath(new URL(`../../../quality/suite-minimums/${name}`, import.meta.url));
  return parseSuiteMinimums(path, JSON.parse(readFileSync(path, 'utf8')));
}

describe('coordination-lease suite minimums', () => {
  it('hold the unit, integration and fuzz minimums, with the four §14 cases in integration', () => {
    const minimums = minimumsOf('coordination-lease.json');
    assert.ok((minimums.unit ?? 0) >= 1, `unit minimum ${String(minimums.unit)}; expected >= 1`);
    assert.ok((minimums.integration ?? 0) >= 4, `integration minimum ${String(minimums.integration)}; expected >= 4`);
    assert.ok((minimums.fuzz ?? 0) >= 1, `fuzz minimum ${String(minimums.fuzz)}; expected >= 1`);
  });

  it('hold an integration minimum for the coordination stack synthesis', () => {
    const minimums = minimumsOf('infra-coordination-stack.json');
    assert.ok((minimums.integration ?? 0) >= 1, `integration minimum ${String(minimums.integration)}; expected >= 1`);
  });
});
