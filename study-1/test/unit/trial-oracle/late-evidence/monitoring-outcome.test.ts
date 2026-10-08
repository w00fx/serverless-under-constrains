// How late monitoring effectively ended (BR-RUA-043, D-16): complete only after at least 120 s with
// every late record readable; a declared shortened, skipped or failed monitoring stays so, with the
// reason, and a malformed window is refused.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { UtcMillis } from '../../../../src/record-contract/primitives.ts';
import {
  MINIMUM_MONITORING_MS,
  effectiveMonitoring,
  monitoringWindow,
} from '../../../../src/trial-oracle/late-evidence/monitoring-outcome.ts';
import type { LateProblem } from '../../../../src/trial-oracle/late-evidence/late-evidence-reasons.ts';
import { refusalOf } from './support/late-fixtures.ts';

const START = '2026-10-05T13:30:00.000Z' as UtcMillis;
const AFTER_120_S = '2026-10-05T13:32:00.000Z' as UtcMillis;
const AFTER_119_999_MS = '2026-10-05T13:31:59.999Z' as UtcMillis;
const GAP: LateProblem = {
  code: 'LATE_SEQUENCE_BROKEN',
  artifact_path: 'late-evidence/late-evidence-stream.jsonl',
  detail: 'line 2: sequence 3; expected 2 (dense from 1)',
};

describe('monitoringWindow', () => {
  it('records no window for a skipped monitoring', () => {
    assert.deepEqual(monitoringWindow({ outcome: 'skipped' }), { ok: true, value: {} });
  });

  it('keeps the recorded times', () => {
    assert.deepEqual(monitoringWindow({ outcome: 'complete', started_at: START, ended_at: AFTER_120_S }), {
      ok: true,
      value: { started_at: START, ended_at: AFTER_120_S },
    });
    assert.deepEqual(monitoringWindow({ outcome: 'failed', started_at: START }), {
      ok: true,
      value: { started_at: START },
    });
    assert.deepEqual(monitoringWindow({ outcome: 'shortened' }), { ok: true, value: {} });
  });

  it('refuses a time that is not an existing UTC instant', () => {
    const refused = monitoringWindow({
      outcome: 'complete',
      started_at: START,
      ended_at: '2026-02-30T00:00:00.000Z' as UtcMillis,
    });
    assert.equal(refused.ok, false);
    assert.equal(refusalOf(refused).code, 'MONITORING_WINDOW_INVALID');
    assert.match(refusalOf(refused).detail, /"2026-02-30T00:00:00.000Z"; expected YYYY-MM-DDTHH:mm:ss.SSSZ/);
  });

  it('refuses an end without a start', () => {
    const refused = monitoringWindow({ outcome: 'shortened', ended_at: AFTER_120_S });
    assert.match(refusalOf(refused).detail, /without a start; expected monitoring_started_at too/);
  });

  it('refuses an end before the start, and accepts an empty window', () => {
    const refused = monitoringWindow({ outcome: 'complete', started_at: AFTER_120_S, ended_at: START });
    assert.match(refusalOf(refused).detail, /before it started at .*; expected end >= start/);
    assert.equal(monitoringWindow({ outcome: 'complete', started_at: START, ended_at: START }).ok, true);
  });
});

describe('effectiveMonitoring', () => {
  it('is complete after at least 120 s without problems', () => {
    assert.equal(MINIMUM_MONITORING_MS, 120_000);
    const window = { started_at: START, ended_at: AFTER_120_S };
    assert.deepEqual(effectiveMonitoring('complete', window, []), { outcome: 'complete', window, reasons: [] });
  });

  it('is shortened when a declared complete monitoring lasted less than 120 s', () => {
    const monitoring = effectiveMonitoring('complete', { started_at: START, ended_at: AFTER_119_999_MS }, []);
    assert.equal(monitoring.outcome, 'shortened');
    assert.deepEqual(
      monitoring.reasons.map((reason) => [reason.code, reason.subject]),
      [['MONITORING_WINDOW_SHORT', 'BR-RUA-043']],
    );
    assert.match(monitoring.reasons[0]?.detail ?? '', /lasted 119999 ms; expected at least 120000 ms/);
  });

  it('is shortened when a declared complete monitoring has no measurable window', () => {
    assert.equal(effectiveMonitoring('complete', { started_at: START }, []).outcome, 'shortened');
    assert.equal(effectiveMonitoring('complete', {}, []).outcome, 'shortened');
  });

  it('fails when late evidence could not be read, with the problem reasons', () => {
    const monitoring = effectiveMonitoring('complete', { started_at: START, ended_at: AFTER_120_S }, [GAP]);
    assert.equal(monitoring.outcome, 'failed');
    assert.deepEqual(
      monitoring.reasons.map((reason) => reason.code),
      ['LATE_SEQUENCE_BROKEN'],
    );
  });

  it('keeps a declared shortened, skipped or failed outcome with its reason first', () => {
    for (const [declared, code] of [
      ['shortened', 'MONITORING_SHORTENED'],
      ['skipped', 'MONITORING_SKIPPED'],
      ['failed', 'MONITORING_FAILED'],
    ] as const) {
      const monitoring = effectiveMonitoring(declared, {}, [GAP]);
      assert.equal(monitoring.outcome, declared);
      assert.deepEqual(
        monitoring.reasons.map((reason) => reason.code),
        [code, 'LATE_SEQUENCE_BROKEN'],
      );
      assert.match(monitoring.reasons[0]?.detail ?? '', new RegExp(`declared ${declared}; expected complete`));
    }
  });
});
