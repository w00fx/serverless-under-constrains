// Telemetry availability (BR-RUA-037, AC-RUA-054): each signal located or not, never blocking.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  captureTelemetryAvailability,
  signalAvailability,
  TELEMETRY_SIGNALS,
} from '../../../src/evidence-collection/telemetry-availability.ts';
import {
  assertValidRecord,
  collectionClock,
  PROBE_SCOPE,
  TRIAL_SCOPE,
} from '../../support/evidence-collection/collection-fixtures.ts';
import { ScriptedTelemetryProbe } from '../../support/evidence-collection/scripted-telemetry-probe.ts';

describe('captureTelemetryAvailability', () => {
  it('records each signal for the unit it was probed for', async () => {
    const probe = new ScriptedTelemetryProbe({ logs: ['/aws/lambda/suc1-caller'], metrics: ['Invocations'] });
    probe.scriptFailure('traces', 'ThrottlingException');
    const record = await captureTelemetryAvailability(probe, TRIAL_SCOPE, collectionClock());
    assertValidRecord(record, 'telemetry_availability');
    assert.deepEqual(record['logs'], { availability: 'available', locators: ['/aws/lambda/suc1-caller'], reasons: [] });
    assert.deepEqual(record['metrics'], { availability: 'available', locators: ['Invocations'], reasons: [] });
    assert.deepEqual(record['traces'], {
      availability: 'unavailable',
      locators: [],
      reasons: [
        {
          code: 'TELEMETRY_UNAVAILABLE',
          subject: 'BR-RUA-037',
          detail: 'traces could not be located: ThrottlingException; expected a successful lookup',
        },
      ],
    });
    assert.deepEqual(
      probe.lookups().map((lookup) => [lookup.signal, lookup.scope]),
      TELEMETRY_SIGNALS.map((signal) => [signal, TRIAL_SCOPE]),
    );
  });

  it('records the probe without a trial identity', async () => {
    const record = await captureTelemetryAvailability(new ScriptedTelemetryProbe(), PROBE_SCOPE, collectionClock());
    assertValidRecord(record, 'probe telemetry_availability');
    assert.equal('trial_id' in record, false);
  });
});

describe('signalAvailability', () => {
  it('is unavailable when the lookup finds no non-empty locator', () => {
    for (const found of [[], ['']]) {
      const signal = signalAvailability('logs', { ok: true, value: found });
      assert.equal(signal.availability, 'unavailable');
      assert.deepEqual(
        signal.reasons.map((reason) => reason.code),
        ['TELEMETRY_NOT_FOUND'],
      );
    }
    assert.deepEqual(signalAvailability('logs', { ok: true, value: ['', 'g'] }).locators, ['g']);
  });
});
