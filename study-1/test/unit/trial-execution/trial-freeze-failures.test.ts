// What the freeze tolerates and what fails it (design §10.2 T10-T11, D-29; BR-RUA-043): a
// collected file with no trial path, observations JSON cannot represent, a trial file that
// already exists and an evaluation the oracle refuses are reported and the freeze goes on; an
// evidence index that cannot be built over the package fails it, with every earlier problem. The
// freeze runs over the named OfflinePackageStorage fake, with no execution core files.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CollectedFile } from '../../../src/evidence-collection/collection-buffer.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { RunnerTrialJournal } from '../../../src/trial-execution/runner-trial-journal.ts';
import type { SettlementReading } from '../../../src/trial-execution/settlement-reading.ts';
import { freezeTrialEvidence } from '../../../src/trial-execution/trial-freeze.ts';
import { freezeTrialInputs, trialFilePath } from '../../../src/trial-execution/trial-inputs.ts';
import { SequentialUuidSource } from '../../support/kernel/sequential-uuid-source.ts';
import { offlineExecution, offlineTrialPlan } from '../../support/offline-cloud/offline-execution.ts';
import { OfflinePackageStorage } from '../../support/offline-cloud/offline-package-storage.ts';
import { PUBLISHED_AT, quietSample } from './support/trial-execution-fixtures.ts';

const clock = { now: (): Date => new Date('2026-10-05T12:20:00.000Z') };

describe('freezeTrialEvidence', () => {
  it('reports tolerated problems and fails when no evidence index can be built', async () => {
    const execution = offlineExecution('run');
    const plan = offlineTrialPlan(execution, 1);
    const storage = new OfflinePackageStorage();
    const target = { files: storage, package_directory: execution.package_directory };
    const inputs = await freezeTrialInputs(target, plan, clock);
    assert.ok(inputs.ok);
    const { manifest, manifest_sha256 } = inputs.value;
    const trialId = plan.trial.trial_id;
    const samplesPath = trialFilePath(execution.package_directory, trialId, 'settlementSamples');
    assert.equal((await storage.writeOnce(samplesPath, Uint8Array.of(1))).ok, true);
    const ids = new SequentialUuidSource('12121212');
    const journal = new RunnerTrialJournal({
      file: storage,
      package_directory: execution.package_directory,
      execution: plan.execution,
      execution_manifest_sha256: plan.execution_manifest_sha256,
      trial_id: trialId,
      trial_manifest_sha256: manifest_sha256,
      clock,
      ids,
    });
    const round: SettlementReading = {
      sample: quietSample(30_000),
      source_observation: { approximate_visible: Number.NaN },
      dlq_observation: {},
      failures: [{ code: 'QUEUE_UNAVAILABLE', subject: 'BR-RUA-032', detail: 'scripted' }],
    };
    const unplaced = {
      key: 'executionConfiguration',
      role: 'supplementary',
      bytes: Uint8Array.of(1),
    } as unknown as CollectedFile;
    const frozen = await freezeTrialEvidence(
      {
        target,
        journal,
        clock,
        validator: createRecordValidator(),
        execution: plan.execution,
        scope: {
          execution: plan.execution,
          execution_manifest_sha256: plan.execution_manifest_sha256,
          unit: { kind: 'trial', trial_id: trialId, trial_manifest_sha256: manifest_sha256 },
        },
        manifest,
      },
      {
        collection: {
          files: [unplaced],
          failures: [{ code: 'COLLECTED', subject: 'BR-RUA-043', detail: 'scripted' }],
          ledger_complete: false,
        },
        rounds: [round],
        assessment: {
          status: 'not_established',
          reasons: [{ code: 'DEADLINE', subject: 'BR-RUA-032', detail: 'scripted' }],
          restarts: [{ at: PUBLISHED_AT, cause: 'SOURCE_VISIBLE' }],
        },
      },
    );
    assert.equal(frozen.ok, false);
    const codes = frozen.error.map((reason) => reason.code);
    // The tolerated problems in freeze order, then the oracle's refusal of a package with no
    // execution manifest (WP-14) and the index's refusal of each absent core file (WP-13).
    assert.deepEqual(codes, [
      'QUEUE_UNAVAILABLE',
      'COLLECTED',
      'COLLECTED_FILE_UNPLACED',
      'RECORD_NOT_REPRESENTABLE',
      'TRIAL_FILE_NOT_WRITTEN',
      'TRIAL_EXECUTION_UNKNOWN',
      ...Array.from({ length: 6 }, () => 'CORE_FILE_MISSING'),
    ]);
    assert.equal(frozen.error[4]?.artifact_path, samplesPath);
    assert.equal(
      [...storage.filesUnder(execution.package_directory).keys()].some((path) => path.endsWith('evidence-index.json')),
      false,
    );
  });
});
