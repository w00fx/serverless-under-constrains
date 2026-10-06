// What a capture reads and how its records correlate (design §9.3; BR-RUA-008, D-06): the trial
// and probe partition keys, the execution-level partitions, and the correlation members.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  capturePartitionKey,
  correlationFields,
  executionPartitionKey,
  isTrialScope,
} from '../../../src/evidence-collection/capture-scope.ts';
import { DIGESTS, IDS } from '../../contract/record-contract/group-a/support/sample-values.ts';
import {
  EXECUTION,
  PROBE_PK,
  PROBE_SCOPE,
  RUN_ID,
  TRIAL_ID,
  TRIAL_PK,
  TRIAL_SCOPE,
} from '../../support/evidence-collection/collection-fixtures.ts';

describe('capture scope', () => {
  it('reads the trial partition `<execution_id>#<trial_id>` and the probe partition `<execution_id>#probe`', () => {
    assert.equal(capturePartitionKey(TRIAL_SCOPE), TRIAL_PK);
    assert.equal(capturePartitionKey(PROBE_SCOPE), PROBE_PK);
  });

  it('names the execution-level partitions by kind (D-10, addendum §2, A-09)', () => {
    for (const kind of ['canary', 'warmup', 'provider'] as const) {
      assert.equal(executionPartitionKey(EXECUTION, DIGESTS.executionManifest, kind), `${RUN_ID}#${kind}`);
    }
    const probe = { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: IDS.transportProbe } as const;
    assert.equal(executionPartitionKey(probe, DIGESTS.executionManifest, 'canary'), `${IDS.transportProbe}#canary`);
  });

  it('correlates trial records with the trial and probe records with the execution only', () => {
    assert.deepEqual(correlationFields(TRIAL_SCOPE), {
      run_id: RUN_ID,
      execution_manifest_sha256: DIGESTS.executionManifest,
      trial_id: TRIAL_ID,
      trial_manifest_sha256: DIGESTS.trialManifest,
    });
    assert.deepEqual(correlationFields(PROBE_SCOPE), {
      run_id: RUN_ID,
      execution_manifest_sha256: DIGESTS.executionManifest,
    });
  });

  it('narrows to trial scopes', () => {
    assert.equal(isTrialScope(TRIAL_SCOPE), true);
    assert.equal(isTrialScope(PROBE_SCOPE), false);
  });
});
