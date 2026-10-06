// The business inputs of the monetary rules: the payment and the approved decision, each located
// at its subject artifact, its expected path, or the layout's path, and present only when usable.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ingestEvidence } from '../../../src/evidence-ingestion/ingest-evidence.ts';
import { PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import { businessInputs, inputMissingReason } from '../../../src/trial-oracle/oracle-inputs.ts';
import { builtEvidence, ORACLE_VALIDATOR, trialIngestionInput } from './support/built-trials.ts';

const CONTROL = { base: 'run-conventional-control' } as const;

describe('businessInputs', () => {
  it('reads the payment and decision of a complete trial, with their references', () => {
    const inputs = businessInputs(builtEvidence(CONTROL));
    assert.equal(inputs.payment.record?.payment_id, 'pay-poc-001');
    assert.equal(inputs.payment.record.captured_amount_minor, 10000);
    assert.equal(inputs.decision.record?.refund_request_id, 'ref-poc-001');
    assert.match(inputs.payment.path, /^trials\/[0-9a-f-]+\/inputs\/payment\.json$/);
    assert.equal(inputs.payment.ref?.artifact_path, inputs.payment.path);
    assert.equal(inputs.decision.ref?.artifact_path, inputs.decision.path);
    assert.equal(inputs.decision.artifact_class, 'approved_decision');
  });

  it('locates an absent input at its expected path, with neither reference nor record', () => {
    const inputs = businessInputs(
      builtEvidence({ ...CONTROL, operations: [{ op: 'delete_file', path: '$trial/inputs/payment.json' }] }),
    );
    assert.match(inputs.payment.path, /^trials\/[0-9a-f-]+\/inputs\/payment\.json$/);
    assert.equal(inputs.payment.ref, undefined);
    assert.equal(inputs.payment.record, undefined);
  });

  it('keeps the reference of a given but unreadable input and no record', () => {
    const inputs = businessInputs(
      builtEvidence({
        ...CONTROL,
        operations: [{ op: 'truncate', path: '$trial/inputs/approved-decision.json', length: 5 }],
      }),
    );
    assert.ok(inputs.decision.ref !== undefined);
    assert.equal(inputs.decision.record, undefined);
  });

  it("falls back to the layout's path when the expected set does not name the input", () => {
    const input = trialIngestionInput(CONTROL);
    const evidence = ingestEvidence(
      {
        ...input,
        artifacts: input.artifacts.filter((artifact) => !artifact.path.endsWith('/inputs/payment.json')),
        expected: input.expected.filter((artifact) => artifact.artifact_class !== 'payment'),
      },
      ORACLE_VALIDATOR,
    );
    const trial = evidence.scope.trial;
    assert.ok(trial !== undefined);
    assert.equal(
      businessInputs(evidence).payment.path,
      PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: trial.trial_id }, 'payment'),
    );
  });

  it('falls back to the probe layout when the evidence names no trial', () => {
    const input = trialIngestionInput(CONTROL);
    const evidence = ingestEvidence(
      {
        ...input,
        artifacts: input.artifacts.filter(
          (artifact) =>
            !artifact.path.endsWith('/inputs/approved-decision.json') &&
            !artifact.path.endsWith('/trial-manifest.json'),
        ),
        expected: input.expected.filter((artifact) => artifact.artifact_class !== 'approved_decision'),
      },
      ORACLE_VALIDATOR,
    );
    assert.equal(evidence.scope.trial, undefined);
    assert.equal(
      businessInputs(evidence).decision.path,
      PACKAGE_LAYOUT.unitFile({ kind: 'probe' }, 'approvedDecision'),
    );
  });
});

describe('inputMissingReason', () => {
  it('is INPUT_MISSING at the input path, under the given subject, naming the class', () => {
    const inputs = businessInputs(builtEvidence(CONTROL));
    const reason = inputMissingReason(inputs.payment, 'BR-RUA-002');
    assert.deepEqual(reason, {
      code: 'INPUT_MISSING',
      subject: 'BR-RUA-002',
      artifact_path: inputs.payment.path,
      detail: `${inputs.payment.path} has no usable payment; expected the trial's payment document`,
    });
  });
});
