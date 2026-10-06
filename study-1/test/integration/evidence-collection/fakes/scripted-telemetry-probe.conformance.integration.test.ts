// Conformance of ScriptedTelemetryProbe (design §12.2). The telemetry probe has no binding in this
// package yet (its composition belongs to the runner), so the fake is held to the port contract
// the collector relies on: a lookup answers its signal's locators or a bare failure code, an
// unscripted signal finds nothing, and every lookup is recorded with the scope it was for.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PROBE_SCOPE, TRIAL_SCOPE } from '../../../support/evidence-collection/collection-fixtures.ts';
import { ScriptedTelemetryProbe } from '../../../support/evidence-collection/scripted-telemetry-probe.ts';

describe('ScriptedTelemetryProbe conformance', () => {
  it('answers the scripted locators, nothing for an unscripted signal, and the failure code', async () => {
    const probe = new ScriptedTelemetryProbe({ logs: ['/aws/lambda/suc1-caller'], metrics: [] });
    probe.scriptFailure('traces', 'AccessDeniedException');
    assert.deepEqual(await probe.locate('logs', TRIAL_SCOPE), { ok: true, value: ['/aws/lambda/suc1-caller'] });
    assert.deepEqual(await probe.locate('metrics', TRIAL_SCOPE), { ok: true, value: [] });
    assert.deepEqual(await probe.locate('traces', PROBE_SCOPE), {
      ok: false,
      error: { code: 'AccessDeniedException' },
    });
    assert.deepEqual(await new ScriptedTelemetryProbe().locate('logs', TRIAL_SCOPE), { ok: true, value: [] });
  });

  it('records each lookup with its scope, and returns copies of the locators', async () => {
    const probe = new ScriptedTelemetryProbe({ logs: ['a'] });
    const first = await probe.locate('logs', TRIAL_SCOPE);
    assert.ok(first.ok);
    (first.value as string[]).push('mutated');
    assert.deepEqual(await probe.locate('logs', PROBE_SCOPE), { ok: true, value: ['a'] });
    assert.deepEqual(probe.lookups(), [
      { signal: 'logs', scope: TRIAL_SCOPE },
      { signal: 'logs', scope: PROBE_SCOPE },
    ]);
  });
});
