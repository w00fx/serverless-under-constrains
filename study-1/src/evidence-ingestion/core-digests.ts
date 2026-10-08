// Design §8.2 step I3: the frozen core files bind each other by digest (BR-RUA-040). The trial
// manifest names its parent execution manifest, the resource manifest, the payment and the
// approved decision; every record of the active execution names the execution manifest; every
// record of the subject trial names the trial manifest; and a re-evaluated package's bytes must
// still be the bytes its evidence index recorded. Any difference is CORE_FILE_DIGEST_MISMATCH,
// which makes evidence integrity invalid (BR-RUA-034). Findings are aggregated per artifact and
// referencing member (A-12).

import type { JsonValue, Sha256Hex } from '../record-contract/primitives.ts';
import { boundedJsonText } from '../record-contract/json-value.ts';
import type { ArtifactClass } from '../record-contract/records/group-c/vocabulary.ts';
import { aggregatedDetail, ingestionFinding } from './ingestion-findings.ts';
import type { EvidenceScope, IngestedArtifact, IngestedRecord, IngestionFinding } from './ingestion-model.ts';
import { executionIdField, executionIdValue, ownString } from './record-correlation.ts';

/** The trial manifest members that pin another core file, with the class of the file they pin. */
const TRIAL_MANIFEST_PINS: readonly { readonly member: string; readonly artifact_class: ArtifactClass }[] = [
  { member: 'resource_manifest_sha256', artifact_class: 'resource_manifest' },
  { member: 'payment_sha256', artifact_class: 'payment' },
  { member: 'approved_decision_sha256', artifact_class: 'approved_decision' },
];

interface DigestReference {
  readonly member: string;
  /** What the member must name, for the finding's detail. */
  readonly expectation: string;
  readonly actual: Sha256Hex;
  /** Whether a record is bound by this reference. */
  readonly binds: (value: JsonValue) => boolean;
}

/**
 * Every core-file digest mismatch among the subject and supplementary artifacts. Only parsed,
 * non-schema-invalid records are read, and only their own string members.
 *
 * @example
 * checkCoreDigests(artifacts, scope, input.indexed_digests); // [] when every digest agrees
 */
export function checkCoreDigests(
  artifacts: readonly IngestedArtifact[],
  scope: EvidenceScope,
  indexedDigests: ReadonlyMap<string, Sha256Hex> | undefined,
): readonly IngestionFinding[] {
  const examined = artifacts.filter((artifact) => artifact.origin !== 'execution_scope');
  return [
    ...trialManifestPins(examined),
    ...examined.flatMap((artifact) => referenceMismatches(artifact, digestReferences(scope))),
    ...examined.flatMap((artifact) => indexMismatch(artifact, indexedDigests)),
  ];
}

function digestReferences(scope: EvidenceScope): readonly DigestReference[] {
  const references: DigestReference[] = [];
  const execution = scope.execution;
  const executionDigest = scope.execution_manifest_sha256;
  if (execution !== undefined && executionDigest !== undefined) {
    const field = executionIdField(execution);
    const id = executionIdValue(execution);
    references.push({
      member: 'execution_manifest_sha256',
      expectation: 'the execution manifest digest',
      actual: executionDigest,
      binds: (value) => ownString(value, field) === id,
    });
  }
  const trial = scope.trial;
  if (trial !== undefined) {
    references.push({
      member: 'trial_manifest_sha256',
      expectation: 'the trial manifest digest',
      actual: trial.trial_manifest_sha256,
      binds: (value) => ownString(value, 'trial_id') === trial.trial_id,
    });
  }
  return references;
}

function referenceMismatches(
  artifact: IngestedArtifact,
  references: readonly DigestReference[],
): readonly IngestionFinding[] {
  const readable = artifact.records.filter((record) => record.validity !== 'schema_invalid');
  return references.flatMap((reference) => {
    const mismatched = readable.flatMap((record) => {
      const claimed = ownString(record.value, reference.member);
      const binds = reference.binds(record.value) && claimed !== undefined && claimed !== reference.actual;
      return binds ? [{ record, claimed }] : [];
    });
    return mismatchFinding(artifact.path, reference, mismatched);
  });
}

function mismatchFinding(
  path: string,
  reference: DigestReference,
  mismatched: readonly { readonly record: IngestedRecord; readonly claimed: string }[],
): readonly IngestionFinding[] {
  const [first] = mismatched;
  if (first === undefined) {
    return [];
  }
  const where = first.record.line_number === undefined ? 'document' : `line ${String(first.record.line_number)}`;
  const detail = aggregatedDetail(
    `${where}: ${reference.member} names ${boundedJsonText(first.claimed)}; expected ${reference.expectation}`,
    mismatched.length,
  );
  return [
    ingestionFinding('CORE_FILE_DIGEST_MISMATCH', detail, {
      artifact_path: path,
      event_id: ownString(first.record.value, 'event_id'),
      occurrences: mismatched.length,
    }),
  ];
}

// The trial manifest pins files by the digest of their exact bytes; an absent pinned file is
// ARTIFACT_MISSING (I1), not a mismatch.
function trialManifestPins(artifacts: readonly IngestedArtifact[]): readonly IngestionFinding[] {
  const manifest = artifacts.find((artifact) => artifact.artifact_class === 'trial_manifest');
  const [record] = manifest?.records ?? [];
  if (manifest === undefined || record?.validity !== 'valid') {
    return [];
  }
  return TRIAL_MANIFEST_PINS.flatMap((pin) => {
    const pinned = artifacts.find((artifact) => artifact.artifact_class === pin.artifact_class);
    const claimed = ownString(record.value, pin.member);
    if (pinned === undefined || claimed === pinned.sha256) {
      return [];
    }
    const detail = `${pin.member} names ${String(claimed)}; expected the digest of ${pinned.path}`;
    return [ingestionFinding('CORE_FILE_DIGEST_MISMATCH', detail, { artifact_path: manifest.path })];
  });
}

function indexMismatch(
  artifact: IngestedArtifact,
  indexedDigests: ReadonlyMap<string, Sha256Hex> | undefined,
): readonly IngestionFinding[] {
  const indexed = indexedDigests?.get(artifact.path);
  if (indexed === undefined || indexed === artifact.sha256) {
    return [];
  }
  const detail = `bytes digest to ${artifact.sha256}; expected the evidence index digest ${indexed}`;
  return [ingestionFinding('CORE_FILE_DIGEST_MISMATCH', detail, { artifact_path: artifact.path })];
}
