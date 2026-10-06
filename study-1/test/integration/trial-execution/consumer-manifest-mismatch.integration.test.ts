// AC-RUA-019 (integration; cases: wrong execution identity, wrong trial-manifest digest), end to
// end through trial execution (design §14): the runner publishes the trial message, the consumer
// receives a body whose execution identity or trial-manifest digest is not the frozen trial's,
// records MESSAGE_REJECTED, makes no provider call and leaves effect knowledge NOT_ATTEMPTED. The
// runner still observes, collects and freezes the trial, and the frozen trial evaluates to G2
// `invalid`, verdict `indeterminate` and `correct_completion: null` (D-28).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { OfflineCloud } from '../../support/offline-cloud/offline-cloud.ts';
import { gateValue, recordTypes, trialLines, trialRecord } from './support/frozen-trial-files.ts';

const OTHER_RUN_ID = '00000000-0000-4000-8000-0000000000ff';
const OTHER_TRIAL_MANIFEST_SHA = 'f'.repeat(64);

async function runTamperedControlTrial(field: string, value: string): Promise<{ cloud: OfflineCloud; trialId: Uuid4 }> {
  const cloud = new OfflineCloud('run');
  await cloud.startExecution();
  cloud.publisher.tamperNextBody(
    (body) => `${JSON.stringify({ ...(JSON.parse(body) as JsonObject), [field]: value })}\n`,
  );
  const report = await cloud.runTrial(1);
  assert.equal(report.kind, 'frozen');
  return { cloud, trialId: report.trial_id };
}

function assertRejectedWithoutProviderCall(cloud: OfflineCloud, trialId: Uuid4, reason: string): void {
  const caller = trialLines(cloud, trialId, 'callerJournal');
  const rejected = caller.find((event) => event['record_type'] === 'trial_message_rejected');
  const finished = caller.find((event) => event['record_type'] === 'request_state_recorded');
  assert.deepEqual(
    {
      reason: rejected?.['reason'],
      terminal: finished?.['processing_terminal_reason'],
      knowledge: finished?.['effect_knowledge'],
    },
    { reason, terminal: 'MESSAGE_REJECTED', knowledge: 'NOT_ATTEMPTED' },
  );
  assert.equal(recordTypes(caller).includes('attempt_registered'), false);
  assert.deepEqual(cloud.invoker.finished(), []);
  assert.deepEqual(trialLines(cloud, trialId, 'providerJournal'), []);
}

function assertIndeterminateByTraceability(cloud: OfflineCloud, trialId: Uuid4): void {
  const result = trialRecord(cloud, trialId, 'oracleResult');
  assert.deepEqual(
    {
      traceability: gateValue(result, 'traceability'),
      validity: result['trial_validity'],
      verdict: result['preservation_verdict'],
      correct_completion: result['correct_completion'],
    },
    { traceability: 'invalid', validity: 'invalid', verdict: 'indeterminate', correct_completion: null },
  );
}

describe('AC-RUA-019 consumer manifest mismatch through trial execution', () => {
  it('wrong-execution-identity: MESSAGE_REJECTED, no provider call, NOT_ATTEMPTED; frozen G2 invalid, indeterminate', async () => {
    const { cloud, trialId } = await runTamperedControlTrial('run_id', OTHER_RUN_ID);

    assertRejectedWithoutProviderCall(cloud, trialId, 'EXECUTION_IDENTITY_MISMATCH');
    assertIndeterminateByTraceability(cloud, trialId);
  });

  it('wrong-trial-manifest-digest: MESSAGE_REJECTED, no provider call, NOT_ATTEMPTED; frozen G2 invalid, indeterminate', async () => {
    const { cloud, trialId } = await runTamperedControlTrial('trial_manifest_sha256', OTHER_TRIAL_MANIFEST_SHA);

    assertRejectedWithoutProviderCall(cloud, trialId, 'TRIAL_MANIFEST_DIGEST_MISMATCH');
    assertIndeterminateByTraceability(cloud, trialId);
  });
});
