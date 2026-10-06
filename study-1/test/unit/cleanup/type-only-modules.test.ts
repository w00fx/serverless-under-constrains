// The cleanup port and discovery modules declare types only (human decision A-10 excludes such
// modules from the mutation targets). This keeps them so: each loads under type stripping and
// exports no runtime value, and a runtime statement added later would fail here.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('cleanup type-only modules', () => {
  it('cleanup-ports.ts exports no runtime value', async () => {
    const loaded: Readonly<Record<string, unknown>> = await import('../../../src/cleanup/cleanup-ports.ts');
    assert.deepEqual(Object.keys(loaded), []);
  });

  it('discovery.ts exports no runtime value', async () => {
    const loaded: Readonly<Record<string, unknown>> = await import('../../../src/cleanup/discovery.ts');
    assert.deepEqual(Object.keys(loaded), []);
  });
});
