// AC-RUA-054 golden (BR-RUA-037): "Given a trial whose logs, metrics or traces are unavailable,
// when the oracle evaluates it with complete primary evidence, then the verdict is derived normally
// and the telemetry's unavailability is recorded." Each case is the conventional treatment trial
// with one signal unavailable; its verdict projection must equal that of the same trial with
// telemetry present (`matrix-03`), and the ingested telemetry record must still say which signal
// was unavailable and why.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { verdictProjection } from '../../../../src/trial-oracle/verdict-projection.ts';
import type { VerdictProjection } from '../../../../src/trial-oracle/verdict-projection.ts';
import { evaluateIntegrityCase, integrityMismatches } from './support/integrity-golden.ts';
import type { IntegrityEvaluation } from './support/integrity-golden.ts';

type TelemetrySignal = 'logs' | 'metrics' | 'traces';

/** The same trial with every telemetry signal available. */
const TELEMETRY_PRESENT = 'matrix-03';

function projectionOf(evaluated: IntegrityEvaluation): VerdictProjection {
  const { evaluation } = evaluated;
  if (!evaluation.ok) {
    throw new Error(`${evaluated.loaded.golden_case.case_id} was refused; expected an oracle result`);
  }
  return verdictProjection(evaluation.value.result);
}

async function assertTelemetryMissing(caseId: string, signal: TelemetrySignal): Promise<void> {
  assert.deepEqual(await integrityMismatches(caseId), []);
  const missing = await evaluateIntegrityCase(caseId);
  const present = await evaluateIntegrityCase(TELEMETRY_PRESENT);
  assert.deepEqual(projectionOf(missing), projectionOf(present));
  const telemetry = missing.evidence.observations.telemetry?.record;
  assert.ok(telemetry, `${caseId} has no ingested telemetry record; expected one recording the unavailability`);
  assert.equal(telemetry[signal].availability, 'unavailable');
  assert.deepEqual(
    telemetry[signal].reasons.map((reason) => reason.code),
    ['TELEMETRY_UNAVAILABLE'],
  );
  assert.equal(present.evidence.observations.telemetry?.record[signal].availability, 'available');
}

describe('AC-RUA-054 missing telemetry does not block a verdict', () => {
  it('logs-missing', async () => {
    await assertTelemetryMissing('logs-missing', 'logs');
  });
  it('metrics-missing', async () => {
    await assertTelemetryMissing('metrics-missing', 'metrics');
  });
  it('traces-missing', async () => {
    await assertTelemetryMissing('traces-missing', 'traces');
  });
});
