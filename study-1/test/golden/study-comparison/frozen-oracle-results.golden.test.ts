// Guard on the oracle results the study-comparison goldens freeze by hand (support/oracle-results.ts,
// written before the WP-14 trial oracle existed). A run summary copies these results unaltered
// (CTR-RUA-002), so a hand-built result that the oracle would never produce makes a golden assert the
// wrong summary: `ac012-summary-includes-all-four` once froze `correct_completion: true` for a pass
// whose request ended PROVIDER_REJECTED, which BR-RUA-030 forbids ("correct_completion = true only
// when preservation_verdict = pass and processing_terminal_reason = SUCCEEDED"). Each case here
// re-evaluates every declared trial with the trial oracle on that trial's own evidence and requires
// the frozen result to state the same verdict projection (D-16), terminal reason, integrity values
// and ledger transactions.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { ingestEvidence } from '../../../src/evidence-ingestion/ingest-evidence.ts';
import { PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { OracleResult } from '../../../src/record-contract/records/group-c/oracle_result.ts';
import { readRunPackage } from '../../../src/study-comparison/run-package-reader.ts';
import { evaluateTrial } from '../../../src/trial-oracle/evaluate-trial.ts';
import { verdictProjection } from '../../../src/trial-oracle/verdict-projection.ts';
import { loadGoldenCase } from '../_harness/golden-harness.ts';
import { ingestionInputFromFiles } from '../evidence-ingestion/ingestion-input.ts';
import { GOLDEN_DEPS } from './support/golden-run.ts';
import { RUN_TRIALS } from './support/run-fixture.ts';

const CASES = 'test/golden/study-comparison/cases';
const CASE_SUFFIX = '.case.ts';
/** The re-evaluation instant; `checked_at` is not part of the compared view. */
const RECHECKED_AT = '2026-10-05T13:30:00.000Z' as UtcMillis;

/** Every study-comparison case, so a case added later is guarded too. */
const CASE_IDS = readdirSync(fileURLToPath(new URL('./cases/', import.meta.url)))
  .filter((name) => name.endsWith(CASE_SUFFIX))
  .map((name) => name.slice(0, -CASE_SUFFIX.length))
  .sort();

/** What the oracle concludes about a trial, independent of when it ran. */
function oracleView(result: OracleResult): object {
  return {
    ...verdictProjection(result),
    processing_terminal_reason: result.processing_terminal_reason,
    identity_integrity: result.identity_integrity,
    control_integrity: result.control_integrity,
    treatment_fidelity: result.treatment_fidelity,
    provider_transaction_ids: result.monetary_observations.provider_transaction_ids,
  };
}

/** The package as the oracle saw it: every frozen oracle result removed. */
function evidenceBeforeOracle(files: ReadonlyMap<string, Uint8Array>): ReadonlyMap<string, Uint8Array> {
  const frozen = new Set(
    RUN_TRIALS.map((trial) => PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: trial.trial_id }, 'oracleResult')),
  );
  return new Map([...files].filter(([path]) => !frozen.has(path)));
}

async function assertFrozenResultsMatchOracle(caseId: string): Promise<void> {
  const loaded = await loadGoldenCase(`${CASES}/${caseId}${CASE_SUFFIX}`);
  const read = readRunPackage(loaded.files, GOLDEN_DEPS);
  assert.ok(read.ok, `${caseId}: run package unreadable`);
  const evidence = evidenceBeforeOracle(loaded.files);
  for (const trialRecords of read.value.trial_records) {
    const trialId = trialRecords.trial.trial_id;
    const frozen = trialRecords.oracle_result?.record;
    assert.ok(frozen !== undefined, `${caseId}: trial ${trialId} has no frozen oracle result`);
    const input = ingestionInputFromFiles(evidence, `trials/${trialId}`);
    const evaluation = evaluateTrial({
      evidence: ingestEvidence(input, GOLDEN_DEPS.validator),
      checked_at: RECHECKED_AT,
    });
    assert.ok(evaluation.ok, `${caseId}: trial ${trialId} refused by the oracle: ${JSON.stringify(evaluation)}`);
    assert.deepEqual(
      oracleView(frozen),
      oracleView(evaluation.value.result),
      `${caseId}: trial ${trialId} frozen result differs from the trial oracle`,
    );
  }
}

describe('study-comparison frozen oracle results agree with the trial oracle', () => {
  it('covers every study-comparison case', () => {
    assert.ok(CASE_IDS.length >= 7, `found ${String(CASE_IDS.length)} case(s) in ${CASES}; expected >= 7`);
  });

  for (const caseId of CASE_IDS) {
    it(`${caseId} freezes what the oracle concludes`, async () => {
      await assertFrozenResultsMatchOracle(caseId);
    });
  }
});
