// The package layout path builders (design §7): one directory per execution kind, amendments under
// `amendments/<execution_id>/<seq:4>-<amendment_id>`, verifications outside every package, and the
// trial or probe directory of per-trial evidence.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PACKAGE_LAYOUT, executionIdOf } from '../../../src/evidence-package/package-layout.ts';
import type { ExecutionIdentity } from '../../../src/record-contract/primitives.ts';
import { PROBE_ID, RUN_ID, TRIAL_ID, VALIDATION_ID, at, uuid } from '../../support/record-contract/record-builders.ts';

const RUN: ExecutionIdentity = { execution_kind: 'RUN', run_id: RUN_ID };
const PROBE: ExecutionIdentity = { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: PROBE_ID };
const VALIDATION: ExecutionIdentity = { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: VALIDATION_ID };

describe('PACKAGE_LAYOUT', () => {
  it('names the single id of every execution kind', () => {
    assert.deepEqual([RUN, PROBE, VALIDATION].map(executionIdOf), [RUN_ID, PROBE_ID, VALIDATION_ID]);
  });

  it('places each execution kind under its own root', () => {
    assert.deepEqual(
      [RUN, PROBE, VALIDATION].map((identity) => PACKAGE_LAYOUT.executionDirectory(identity)),
      [`runs/${RUN_ID}`, `transport-probes/${PROBE_ID}`, `variant-validations/${VALIDATION_ID}`],
    );
  });

  it('pads the amendment sequence to four digits under the execution id', () => {
    assert.equal(PACKAGE_LAYOUT.amendmentsDirectory(RUN), `amendments/${RUN_ID}`);
    assert.equal(PACKAGE_LAYOUT.amendmentDirectory(RUN, 7, uuid(9)), `amendments/${RUN_ID}/0007-${uuid(9)}`);
    assert.equal(PACKAGE_LAYOUT.amendmentDirectory(RUN, 12_345, uuid(9)), `amendments/${RUN_ID}/12345-${uuid(9)}`);
  });

  it('writes verifications and admission attempts outside every package', () => {
    assert.equal(
      PACKAGE_LAYOUT.verificationPath(PROBE, at(5), 'package-verification'),
      `verifications/${PROBE_ID}/${at(5)}-package-verification.json`,
    );
    assert.equal(PACKAGE_LAYOUT.admissionAttemptDirectory(uuid(3)), `admission-attempts/${uuid(3)}`);
  });

  it('builds trial and probe file paths and the summary of each kind', () => {
    assert.equal(
      PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: TRIAL_ID }, 'payment'),
      `trials/${TRIAL_ID}/inputs/payment.json`,
    );
    assert.equal(PACKAGE_LAYOUT.unitFile({ kind: 'probe' }, 'ledgerSnapshot'), 'probe/ledger/ledger-snapshot.json');
    assert.deepEqual(
      (['RUN', 'TRANSPORT_PROBE', 'VARIANT_VALIDATION'] as const).map((kind) => PACKAGE_LAYOUT.summaryPath(kind)),
      ['summary/run-summary.json', 'summary/transport-probe-summary.json', 'summary/validation-summary.json'],
    );
  });
});
