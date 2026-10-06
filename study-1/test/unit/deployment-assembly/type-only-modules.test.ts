// The deployment-assembly ports declare types only (human decision A-10 excludes such modules from
// the mutation targets). This keeps them so: each loads under type stripping and exports no runtime
// value, and a runtime statement added later would fail here. Loading them also gives c8 (all: true)
// its coverage, which the type-only imports elsewhere erase. The reason helper is checked here too.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deploymentReason } from '../../../src/deployment-assembly/deployment-reasons.ts';

describe('deployment-assembly type-only modules', () => {
  it('assembly-file-system.ts, assembly-ports.ts and command-runner.ts export no runtime value', async () => {
    const modules: readonly Readonly<Record<string, unknown>>[] = [
      await import('../../../src/deployment-assembly/assembly-file-system.ts'),
      await import('../../../src/deployment-assembly/assembly-ports.ts'),
      await import('../../../src/deployment-assembly/command-runner.ts'),
    ];
    assert.deepEqual(
      modules.map((loaded) => Object.keys(loaded)),
      [[], [], []],
    );
  });

  it('deploymentReason names the code, the rule and the detail', () => {
    assert.deepEqual(deploymentReason('DEPLOY_COPY_NOT_EMPTY', 'BR-RUA-042', 'x'), {
      code: 'DEPLOY_COPY_NOT_EMPTY',
      subject: 'BR-RUA-042',
      detail: 'x',
    });
  });
});
