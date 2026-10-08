// The subject's typed documents and streams (design §5.3 ObservationView), and the conditional
// DLQ snapshot, required once a settlement sample correlates a DLQ message (design §8.1, BR-RUA-037).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readObservations } from '../../../src/evidence-ingestion/observation-view.ts';
import { ingest, probeInput, subjectOf, text, trialInput, withArtifact } from './support/evidence-fixtures.ts';

const CORRELATED = [
  {
    op: 'set',
    path: '$trial/settlement/settlement-samples.jsonl',
    select: { line: 1 },
    pointer: '/correlated_dlq_message_ids',
    value: ['dlq-message-1'],
  },
] as const;

describe('readObservations', () => {
  it('types every single-record document and stream of a trial', () => {
    const view = ingest(trialInput('run-durable-control')).observations;
    for (const key of [
      'execution_manifest',
      'resource_manifest',
      'trial_manifest',
      'payment',
      'approved_decision',
      'published_message',
      'provider_configuration',
      'treatment_snapshot',
      'durable_executions',
      'telemetry',
    ] as const) {
      assert.notEqual(view[key], undefined, key);
    }
    assert.equal(view.payment?.record.record_type, 'payment');
    assert.equal(view.dlq_snapshot, undefined);
    assert.ok(view.settlement_samples.length > 0);
    assert.ok(view.source_observations.length > 0);
    assert.ok(view.dlq_observations.length > 0);
    assert.equal(view.settlement_samples[0]?.line_number, 1);
  });

  it('leaves out a schema-invalid document and the files a conventional trial does not have', () => {
    const input = trialInput();
    const view = ingest(
      withArtifact(input, `${subjectOf(input)}/inputs/payment.json`, text('{"record_type":"payment"}')),
    ).observations;
    assert.equal(view.payment, undefined);
    assert.equal(view.durable_executions, undefined);
  });

  it('requires the DLQ snapshot once a sample correlates a DLQ message', () => {
    const input = trialInput('run-conventional-control', CORRELATED);
    const evidence = ingest(input);
    const path = `${subjectOf(input)}/queues/dlq-snapshot.json`;
    const expected = input.expected.find((artifact) => artifact.artifact_class === 'dlq_snapshot');
    assert.equal(expected?.path, path);
    const missing = evidence.findings.filter((finding) => finding.code === 'ARTIFACT_MISSING');
    assert.deepEqual(
      missing.map((finding) => [finding.artifact_path, finding.detail]),
      [[path, `${path} (dlq_snapshot) is absent; expected the required artifact to be present`]],
    );
  });

  it('is satisfied by a present DLQ snapshot and silent without a correlated message', () => {
    const input = trialInput('run-conventional-control', CORRELATED);
    const present = ingest(withArtifact(input, `${subjectOf(input)}/queues/dlq-snapshot.json`, text('{}')));
    assert.equal(
      present.findings.some((finding) => finding.code === 'ARTIFACT_MISSING'),
      false,
    );
    const plain = trialInput();
    const evidence = ingest(plain);
    assert.deepEqual(readObservations([...evidence.artifacts.values()], plain.expected).findings, []);
  });

  it('never requires a DLQ snapshot of the probe', () => {
    const input = probeInput(CORRELATED);
    assert.equal(
      input.expected.some((artifact) => artifact.artifact_class === 'dlq_snapshot'),
      false,
    );
    const evidence = ingest(input);
    assert.deepEqual(evidence.observations.settlement_samples[0]?.record.correlated_dlq_message_ids, ['dlq-message-1']);
    assert.deepEqual(evidence.findings, []);
  });
});
