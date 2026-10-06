// The expected artifact sets (design §8.1; BR-RUA-037): a trial expects its manifest, inputs,
// journals, ledger, queue observations and settlement samples; a Durable trial also its execution
// metadata; the DLQ snapshot is conditional and telemetry optional; the probe has no trial-only
// artifact.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { expectedArtifactsFor } from '../../../src/evidence-package/expected-artifacts.ts';
import type { ExpectedPackageArtifact } from '../../../src/evidence-package/expected-artifacts.ts';
import { probeWorkloadRequest } from '../../contract/record-contract/group-a/support/input-examples.ts';
import { trialManifest } from '../../contract/record-contract/group-a/support/manifest-examples.ts';

function byRequirement(artifacts: readonly ExpectedPackageArtifact[], requirement: string): readonly string[] {
  return artifacts
    .filter((artifact) => artifact.requirement === requirement)
    .map((artifact) => artifact.artifact_class);
}

describe('expectedArtifactsFor', () => {
  it('expects every verdict-critical artifact of a conventional trial, sorted by path', () => {
    const manifest = trialManifest();
    const artifacts = expectedArtifactsFor(manifest);
    const paths = artifacts.map((artifact) => artifact.path);
    assert.deepEqual(paths, paths.toSorted());
    assert.deepEqual(byRequirement(artifacts, 'required').toSorted(), [
      'approved_decision',
      'caller_journal',
      'controller_journal',
      'dlq_observations',
      'execution_manifest',
      'ledger_snapshot',
      'payment',
      'provider_journal',
      'provider_trial_configuration',
      'published_message',
      'resource_manifest',
      'runner_journal',
      'settlement_samples',
      'source_observations',
      'treatment_state_snapshot',
      'trial_manifest',
    ]);
    assert.deepEqual(byRequirement(artifacts, 'conditional'), ['dlq_snapshot']);
    assert.deepEqual(byRequirement(artifacts, 'optional'), ['telemetry_availability']);
    assert.ok(paths.includes(`trials/${manifest.trial_id}/inputs/payment.json`));
  });

  it('also requires the Durable execution metadata of a Durable trial', () => {
    const artifacts = expectedArtifactsFor({ ...trialManifest(), variant_id: 'durable' });
    assert.ok(byRequirement(artifacts, 'required').includes('durable_execution_metadata'));
  });

  it('expects no trial-only artifact of the probe', () => {
    const artifacts = expectedArtifactsFor(probeWorkloadRequest());
    const classes = artifacts.map((artifact) => artifact.artifact_class);
    for (const trialOnly of [
      'trial_manifest',
      'published_message',
      'source_observations',
      'dlq_snapshot',
      'durable_execution_metadata',
    ]) {
      assert.equal(classes.includes(trialOnly as never), false, trialOnly);
    }
    assert.ok(artifacts.every((artifact) => !artifact.path.startsWith('trials/')));
    assert.ok(artifacts.some((artifact) => artifact.path === 'probe/ledger/ledger-snapshot.json'));
  });
});
