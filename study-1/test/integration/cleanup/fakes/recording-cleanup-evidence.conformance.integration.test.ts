// Conformance of RecordingCleanupEvidence to the CleanupEvidencePort contract: every operation
// answers a step report (succeeded unless scripted), DLQ capture adds the captured ids, the
// freeze keeps what it was given, calls are recorded with their mode, and a scripted throw
// rejects only its own operation.
//
// Sources (RK-17): no AWS service is emulated; the contract is the project's CleanupEvidencePort
// (design §10.4 steps 1, 2, 4, 7 and 12).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CleanupResults } from '../../../../src/cleanup/cleanup-ports.ts';
import { RecordingCleanupEvidence } from '../../../support/cleanup/recording-cleanup-evidence.ts';

describe('RecordingCleanupEvidence conformance', () => {
  it('answers every operation and records it', async () => {
    const evidence = new RecordingCleanupEvidence();
    const succeeded = { status: 'succeeded', reasons: [] };
    assert.deepEqual(await evidence.completeLateEvidenceCutoff('NORMAL'), succeeded);
    assert.deepEqual(await evidence.freezeLateEvidenceAssessment('EMERGENCY'), succeeded);
    assert.deepEqual(await evidence.capturePreCleanupSnapshot('NORMAL'), succeeded);
    evidence.captureMessages('m1');
    assert.deepEqual(await evidence.captureDlqEvidence('NORMAL'), { ...succeeded, captured_message_ids: ['m1'] });
    const results = { cleanup_result: {}, leak_audit_result: {} } as unknown as CleanupResults;
    assert.deepEqual(await evidence.freezeResults(results), succeeded);
    assert.deepEqual(evidence.frozen(), [results]);
    assert.deepEqual(evidence.calls(), [
      { operation: 'cutoff', mode: 'NORMAL' },
      { operation: 'assessment', mode: 'EMERGENCY' },
      { operation: 'snapshot', mode: 'NORMAL' },
      { operation: 'dlq', mode: 'NORMAL' },
      { operation: 'freeze' },
    ]);
  });

  it('answers scripted reports and throws only where scripted', async () => {
    const evidence = new RecordingCleanupEvidence();
    const skipped = { status: 'skipped' as const, reasons: [{ code: 'C', subject: 's', detail: 'd' }] };
    evidence.answer('cutoff', skipped);
    evidence.throwOn('snapshot');
    assert.deepEqual(await evidence.completeLateEvidenceCutoff('EMERGENCY'), skipped);
    await assert.rejects(evidence.capturePreCleanupSnapshot('NORMAL'), /scripted snapshot evidence fault/);
    assert.deepEqual(await evidence.freezeLateEvidenceAssessment('NORMAL'), { status: 'succeeded', reasons: [] });
  });

  it('rejects with exactly the scripted thrown value', async () => {
    const evidence = new RecordingCleanupEvidence();
    const hostile = Symbol('hostile');
    evidence.throwOn('dlq', hostile);
    await assert.rejects(evidence.captureDlqEvidence('NORMAL'), (thrown) => thrown === hostile);
  });
});
