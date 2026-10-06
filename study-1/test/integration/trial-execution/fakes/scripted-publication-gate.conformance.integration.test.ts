// Conformance of ScriptedPublicationGate to the PublicationGate port (design §10.2 T5, §10.3):
// open by default, and each closing condition, once set, stays set, as a lost lease, exhausted
// safety headroom or a fired interruption source does in the execution runner.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ScriptedPublicationGate } from '../../../support/offline-cloud/scripted-publication-gate.ts';

describe('ScriptedPublicationGate conformance', () => {
  it('is open until a condition closes it, and each condition stays set', () => {
    const gate = new ScriptedPublicationGate();
    assert.deepEqual([gate.publicationAllowed(), gate.mayStartTrial(), gate.interruption()], [true, true, undefined]);
    gate.withholdPublication();
    gate.refuseTrials();
    gate.interrupt({ cause: 'OPERATOR_ABORT', detail: 'SIGINT' });
    assert.deepEqual(
      [gate.publicationAllowed(), gate.mayStartTrial(), gate.interruption()],
      [false, false, { cause: 'OPERATOR_ABORT', detail: 'SIGINT' }],
    );
  });
});
