// AC-RUA-032 golden (design §14): insufficient evidence, or an invalid probe, leaves the transport
// unqualified with an `indeterminate` verdict; each case states its expectation in its case file.

import { describe, it } from 'node:test';

import { assertVerdictCase } from './support/verdict-assertions.ts';

describe('AC-RUA-032 insufficient evidence or an invalid probe is indeterminate', () => {
  it('equal-timestamps', async () => {
    await assertVerdictCase('equal-timestamps');
  });

  it('missing-timestamp', async () => {
    await assertVerdictCase('missing-timestamp');
  });

  it('safety-release', async () => {
    await assertVerdictCase('safety-release');
  });

  it('extra-accepted-call', async () => {
    await assertVerdictCase('extra-accepted-call');
  });
});
