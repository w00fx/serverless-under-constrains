// The execution runner's ports declare types only (human decision A-10 excludes such modules from
// the mutation targets). This keeps it so: the module loads under type stripping and exports no
// runtime value, and a runtime statement added later would fail here. Loading it also gives c8
// (all: true) its coverage, which the type-only imports elsewhere erase.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('execution-lifecycle type-only modules', () => {
  it('execution-ports.ts exports no runtime value', async () => {
    const loaded: Readonly<Record<string, unknown>> =
      await import('../../../src/execution-lifecycle/execution-ports.ts');
    assert.deepEqual(Object.keys(loaded), []);
  });
});
