// AC-RUA-031 golden (design §14): one case per transport condition conclusively violated on clean,
// unaffected evidence, each stated in its case file from the spec text it violates; every one
// rejects the transport with a `fail` verdict.

import { describe, it } from 'node:test';

import { assertVerdictCase } from './support/verdict-assertions.ts';

describe('AC-RUA-031 a conclusively violated condition fails the probe', () => {
  it('br010-reversed-timestamps', async () => {
    await assertVerdictCase('br010-reversed-timestamps');
  });

  it('br011-transport-settled-first', async () => {
    await assertVerdictCase('br011-transport-settled-first');
  });

  it('br012-provider-stopped', async () => {
    await assertVerdictCase('br012-provider-stopped');
  });

  it('br013-wrong-signal-causation', async () => {
    await assertVerdictCase('br013-wrong-signal-causation');
  });

  it('br014-release-before-observation', async () => {
    await assertVerdictCase('br014-release-before-observation');
  });

  it('br015-caller-observed-success', async () => {
    await assertVerdictCase('br015-caller-observed-success');
  });
});
