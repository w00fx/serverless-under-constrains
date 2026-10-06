// Who is being evaluated (design §8.2 before I2): the execution named by the frozen execution
// manifest and, for a trial, the trial its frozen trial manifest declares. Both manifests must be
// schema-valid single documents; the digests the rest of ingestion compares against are those of
// their exact bytes (BR-RUA-040), never the digests a record claims.

import type { ExecutionIdentity } from '../record-contract/primitives.ts';
import type { ExecutionManifest } from '../record-contract/records/group-a/execution_manifest.ts';
import type { TrialManifest } from '../record-contract/records/group-a/trial_manifest.ts';
import type { RecordType } from '../record-contract/record-types.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import type { ParsedArtifact } from './artifact-reading.ts';
import type { EvidenceScope, ExpectedArtifact, SubjectTrial } from './ingestion-model.ts';

interface ValidManifest<T> {
  readonly record: T;
  readonly artifact: ParsedArtifact;
}

/**
 * Resolves the evaluated execution and trial from the subject's manifests. A missing, unparseable
 * or schema-invalid manifest leaves its part of the scope absent; it never throws.
 *
 * @example
 * const scope = resolveScope(parsed, input.expected, false, validator);
 * scope.trial?.trial_id;
 */
export function resolveScope(
  artifacts: readonly ParsedArtifact[],
  expected: readonly ExpectedArtifact[],
  reevaluation: boolean,
  validator: RecordValidator,
): EvidenceScope {
  const subjectKind = expected.some((artifact) => artifact.artifact_class === 'trial_manifest') ? 'trial' : 'probe';
  const execution = validManifest<ExecutionManifest>(artifacts, 'execution_manifest', validator);
  const trial =
    subjectKind === 'trial' ? validManifest<TrialManifest>(artifacts, 'trial_manifest', validator) : undefined;
  return {
    subject_kind: subjectKind,
    ...(execution === undefined
      ? {}
      : {
          execution: executionIdentityOf(execution.record),
          execution_manifest_sha256: execution.artifact.sha256,
        }),
    ...(trial === undefined ? {} : { trial: subjectTrialOf(trial) }),
    reevaluation,
  };
}

function validManifest<T>(
  artifacts: readonly ParsedArtifact[],
  recordType: RecordType & ('execution_manifest' | 'trial_manifest'),
  validator: RecordValidator,
): ValidManifest<T> | undefined {
  const artifact = artifacts.find(
    (candidate) => candidate.origin === 'subject' && candidate.artifact_class === recordType,
  );
  // A JSON document that does not parse has no value, so an unparseable manifest stops here.
  const [document] = artifact?.values ?? [];
  if (artifact === undefined || document === undefined) {
    return undefined;
  }
  const checked = validator.validateAs(recordType, document.value);
  return checked.valid ? { record: checked.record as T, artifact } : undefined;
}

function executionIdentityOf(manifest: ExecutionManifest): ExecutionIdentity {
  switch (manifest.execution_kind) {
    case 'RUN':
      return { execution_kind: 'RUN', run_id: manifest.run_id };
    case 'TRANSPORT_PROBE':
      return { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: manifest.transport_probe_id };
    case 'VARIANT_VALIDATION':
      return { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: manifest.variant_validation_id };
  }
}

function subjectTrialOf(manifest: ValidManifest<TrialManifest>): SubjectTrial {
  return {
    trial_id: manifest.record.trial_id,
    trial_manifest_sha256: manifest.artifact.sha256,
    variant_id: manifest.record.variant_id,
    scenario: manifest.record.scenario,
    sequence: manifest.record.sequence,
  };
}
