// Partition attribution of a caller-journal stream record (design §9.3, D-06, D-10).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveControllerPartition } from '../../../src/treatment-controller/controller-partition.ts';
import {
  CANARY_PK,
  OTHER_RUN_ID,
  PROBE,
  PROBE_ID,
  PROBE_PK,
  RUN,
  RUN_CANARY_PK,
  RUN_ID,
  TRIAL_ID,
  TRIAL_PK,
  VALIDATION,
  VALIDATION_ID,
} from './support/controller-fixtures.ts';

describe('resolveControllerPartition', () => {
  it('attributes a trial partition of a run or a variant validation to its trial', () => {
    assert.deepEqual(resolveControllerPartition(RUN, TRIAL_PK), { kind: 'trial', key: TRIAL_PK, trial_id: TRIAL_ID });
    const validationPk = `${VALIDATION_ID}#${TRIAL_ID}`;
    assert.deepEqual(resolveControllerPartition(VALIDATION, validationPk), {
      kind: 'trial',
      key: validationPk,
      trial_id: TRIAL_ID,
    });
  });

  it('attributes the probe partition only in a transport-probe deployment', () => {
    assert.deepEqual(resolveControllerPartition(PROBE, PROBE_PK), { kind: 'probe', key: PROBE_PK });
    assert.equal(resolveControllerPartition(RUN, `${RUN_ID}#probe`), undefined);
    assert.equal(resolveControllerPartition(PROBE, `${PROBE_ID}#${TRIAL_ID}`), undefined);
  });

  it('attributes the readiness canary partition in every deployment (D-10)', () => {
    assert.deepEqual(resolveControllerPartition(PROBE, CANARY_PK), { kind: 'canary', key: CANARY_PK });
    assert.deepEqual(resolveControllerPartition(RUN, RUN_CANARY_PK), { kind: 'canary', key: RUN_CANARY_PK });
  });

  it('attributes nothing outside this deployment or to a malformed key', () => {
    for (const pk of [
      `${OTHER_RUN_ID}#${TRIAL_ID}`,
      `${RUN_ID}#warmup`,
      `${RUN_ID}#${TRIAL_ID.toUpperCase()}`,
      `${RUN_ID}#`,
      RUN_ID,
      `x${TRIAL_PK}`,
    ]) {
      assert.equal(resolveControllerPartition(RUN, pk), undefined, pk);
    }
    assert.equal(resolveControllerPartition(RUN, 7), undefined);
    assert.equal(resolveControllerPartition(RUN, undefined), undefined);
  });
});
