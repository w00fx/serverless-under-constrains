// The trial-execution ports declare types only (human decision A-10 excludes such modules from the
// mutation targets, decision 61). This keeps it so: it loads under type stripping and exports no
// runtime value, and loading it gives c8 (all: true) its coverage.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('trial-execution type-only modules', () => {
  it('trial-execution-ports.ts exports no runtime value', async () => {
    const loaded: Readonly<Record<string, unknown>> =
      await import('../../../src/trial-execution/trial-execution-ports.ts');
    assert.deepEqual(Object.keys(loaded), []);
  });
});
