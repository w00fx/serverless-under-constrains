// The nine harness bases (design §12.4, WP-09) read back from their committed fixtures. For each
// base the subject trial's observable outcome — Expected Configured Trace counts, final treatment
// state, settlement status and processing terminal reason — matches what the case states from
// the spec; the fixture is schema-valid and internally consistent (BR-RUA-033, BR-RUA-034); the
// runner's settlement assessment agrees with an independent §8.12 re-derivation from the frozen
// samples; and the ledger snapshot was captured inside the settled window (design §7 G1).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { recordText } from '../../support/golden-builder/golden-event-log.ts';
import { fixtureIntegrityProblems } from '../../support/golden-builder/fixture-integrity.ts';
import { BASE_SCENARIO_IDS } from '../../support/golden-builder/golden-plan.ts';
import { deriveSettlement, observeSubject, runnerEvents } from './fixture-observations.ts';
import { expectedMismatches, fixtureRecords, loadGoldenCase } from './golden-harness.ts';
import type { LoadedGoldenCase } from './golden-harness.ts';

const validator = createRecordValidator();
// BR-RUA-032 observation deadline (OR-RUA-002): 600 s after publication.
const OBSERVATION_DEADLINE_MS = 600_000;

const loadedBases = await Promise.all(
  BASE_SCENARIO_IDS.map((base) => loadGoldenCase(`test/golden/_harness/cases/base-${base}.case.ts`)),
);

// Publication starts observation: the published message for a run trial, the probe invocation's
// start for the probe (BR-RUA-027 has no queue).
function observationStartMs(loaded: LoadedGoldenCase): number {
  const published = runnerEvents(loaded, 'trial_message_published')[0];
  if (published !== undefined) {
    return Date.parse(recordText(published, 'occurred_at'));
  }
  const started = fixtureRecords(loaded.files, `${loaded.subject_directory}/journals/caller-journal.jsonl`)[0];
  return Date.parse(started === undefined ? '' : recordText(started, 'occurred_at'));
}

describe('golden harness bases', () => {
  it('declares one case per base scenario', () => {
    assert.deepEqual(
      loadedBases.map((loaded) => loaded.golden_case.base),
      [...BASE_SCENARIO_IDS],
    );
  });

  for (const loaded of loadedBases) {
    const caseId = loaded.golden_case.case_id;

    it(`${caseId}: the subject trial shows the outcome the case states`, () => {
      assert.deepEqual(expectedMismatches(loaded.golden_case.expected, observeSubject(loaded)), []);
    });

    it(`${caseId}: every record is schema-valid with unique ids, dense sequences, resolved causation and true digests`, () => {
      assert.deepEqual(fixtureIntegrityProblems(loaded.files, validator), []);
    });

    it(`${caseId}: the runner's settlement assessment is the §8.12 derivation from the frozen samples`, () => {
      const samples = fixtureRecords(loaded.files, `${loaded.subject_directory}/settlement/settlement-samples.jsonl`);
      const assessed = runnerEvents(loaded, 'settlement_assessed').at(-1);
      const derived = deriveSettlement(samples, observationStartMs(loaded) + OBSERVATION_DEADLINE_MS);
      assert.deepEqual(expectedMismatches({ ...derived, sample_count: samples.length }, assessed), []);
    });

    it(`${caseId}: the ledger snapshot was captured inside the settled window (G1)`, () => {
      const assessed = runnerEvents(loaded, 'settlement_assessed').at(-1);
      const ledger = fixtureRecords(loaded.files, `${loaded.subject_directory}/ledger/ledger-snapshot.json`)[0];
      assert.ok(ledger !== undefined && assessed !== undefined, 'a ledger snapshot and a settlement assessment exist');
      const captured = Date.parse(recordText(ledger, 'captured_at'));
      assert.ok(captured >= Date.parse(recordText(assessed, 'established_at')), 'captured at or after established_at');
      assert.ok(captured <= Date.parse(recordText(assessed, 'rechecked_at')), 'captured at or before rechecked_at');
    });
  }
});
