// Conformance of OfflineTelemetryProbe to the TelemetryProbe port (BR-RUA-037): every signal is
// located under the design §9.7 name of the execution's resources, and the collection hook runs
// once, on the next `logs` read only.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CaptureScope } from '../../../../src/evidence-collection/capture-scope.ts';
import { OfflineTelemetryProbe } from '../../../support/offline-cloud/offline-telemetry-probe.ts';

const scope = {} as CaptureScope;

describe('OfflineTelemetryProbe conformance', () => {
  it('locates every signal under the resource prefix', async () => {
    const probe = new OfflineTelemetryProbe('abcd1234');
    assert.deepEqual(await probe.locate('metrics', scope), { ok: true, value: ['suc1-abcd1234/metrics'] });
    assert.equal(probe.collectionCount(), 0);
  });

  it('runs the collection hook once, at the next logs read', async () => {
    const probe = new OfflineTelemetryProbe('abcd1234');
    let runs = 0;
    probe.onNextCollection(() => {
      runs += 1;
    });
    await probe.locate('traces', scope);
    assert.equal(runs, 0);
    await probe.locate('logs', scope);
    await probe.locate('logs', scope);
    assert.equal(runs, 1);
    assert.equal(probe.collectionCount(), 2);
  });
});
