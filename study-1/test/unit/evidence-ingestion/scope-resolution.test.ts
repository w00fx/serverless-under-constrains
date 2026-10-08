// Who is evaluated (design §8.2): the execution and trial the frozen manifests declare, with the
// digests of their exact bytes (BR-RUA-040), never a digest a record claims.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readArtifacts } from '../../../src/evidence-ingestion/artifact-reading.ts';
import type { EvidenceScope, IngestionInput } from '../../../src/evidence-ingestion/ingestion-model.ts';
import { resolveScope } from '../../../src/evidence-ingestion/scope-resolution.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import {
  VALIDATOR,
  artifactBytes,
  artifactValues,
  probeInput,
  subjectOf,
  text,
  trialInput,
  withArtifact,
} from './support/evidence-fixtures.ts';

const EXECUTION_MANIFEST = 'admission/execution-manifest.json';

function scopeOf(input: IngestionInput, reevaluation = false): EvidenceScope {
  return resolveScope(readArtifacts(input).artifacts, input.expected, reevaluation, VALIDATOR);
}

describe('resolveScope', () => {
  it('resolves a run trial from its manifests', () => {
    const input = trialInput('run-conventional-treatment');
    const manifestPath = `${subjectOf(input)}/trial-manifest.json`;
    const [manifest] = artifactValues(input, manifestPath) as [Record<string, string | number>];
    const scope = scopeOf(input, true);
    assert.equal(scope.subject_kind, 'trial');
    assert.equal(scope.reevaluation, true);
    assert.equal(scope.execution?.execution_kind, 'RUN');
    assert.equal(scope.execution_manifest_sha256, sha256Hex(artifactBytes(input, EXECUTION_MANIFEST)));
    assert.deepEqual(scope.trial, {
      trial_id: manifest['trial_id'],
      trial_manifest_sha256: sha256Hex(artifactBytes(input, manifestPath)),
      variant_id: 'conventional',
      scenario: 'COMMIT_THEN_TIMEOUT',
      sequence: 3,
    });
  });

  it('resolves a variant validation and the transport probe', () => {
    assert.equal(scopeOf(trialInput('validation-durable-control')).execution?.execution_kind, 'VARIANT_VALIDATION');
    const probe = scopeOf(probeInput());
    assert.equal(probe.subject_kind, 'probe');
    assert.equal(probe.execution?.execution_kind, 'TRANSPORT_PROBE');
    assert.equal(probe.trial, undefined);
  });

  it('leaves the execution absent when its manifest is missing, unparseable or schema-invalid', () => {
    const input = trialInput();
    for (const bytes of [undefined, text('{'), text('{"record_type":"execution_manifest"}')]) {
      const scope = scopeOf(withArtifact(input, EXECUTION_MANIFEST, bytes));
      assert.equal(scope.execution, undefined);
      assert.equal(scope.execution_manifest_sha256, undefined);
      assert.notEqual(scope.trial, undefined);
    }
  });

  it('leaves the trial absent when its manifest is missing or schema-invalid', () => {
    const input = trialInput();
    const manifestPath = `${subjectOf(input)}/trial-manifest.json`;
    for (const bytes of [undefined, text('[]')]) {
      const scope = scopeOf(withArtifact(input, manifestPath, bytes));
      assert.equal(scope.subject_kind, 'trial');
      assert.equal(scope.trial, undefined);
    }
  });
});
