// Typed access to the records of the subject's expected artifacts. A record is usable when it is
// schema-valid or only correlation-missing (design §8.2 I2: its other members are valid, so it is
// read, and its `correlation_missing` flag travels with it); a schema-invalid record is never
// read as its type.

import type { ArtifactClass } from '../record-contract/records/group-c/vocabulary.ts';
import type { IngestedArtifact, IngestedRecord, LocatedRecord } from './ingestion-model.ts';

/**
 * The subject artifact of a class, if it was given.
 *
 * @example
 * subjectArtifact(artifacts, 'ledger_snapshot')?.path; // 'trials/<t>/ledger/ledger-snapshot.json'
 */
export function subjectArtifact(
  artifacts: readonly IngestedArtifact[],
  artifactClass: ArtifactClass,
): IngestedArtifact | undefined {
  return artifacts.find((artifact) => artifact.origin === 'subject' && artifact.artifact_class === artifactClass);
}

/**
 * The usable document of a single-record subject artifact, typed as its class's record type. The
 * schema has already proved the shape, which is what makes the cast sound.
 *
 * @example
 * const payment = soleRecord<Payment>(artifacts, 'payment');
 */
export function soleRecord<T>(
  artifacts: readonly IngestedArtifact[],
  artifactClass: ArtifactClass,
): LocatedRecord<T> | undefined {
  const artifact = subjectArtifact(artifacts, artifactClass);
  const [record] = artifact?.records ?? [];
  return artifact === undefined || record === undefined || record.validity === 'schema_invalid'
    ? undefined
    : locateRecord<T>(artifact, record);
}

/**
 * Every usable record of a JSONL subject artifact, in line order.
 *
 * @example
 * const samples = streamRecords<SettlementSample>(artifacts, 'settlement_samples');
 */
export function streamRecords<T>(
  artifacts: readonly IngestedArtifact[],
  artifactClass: ArtifactClass,
): readonly LocatedRecord<T>[] {
  const artifact = subjectArtifact(artifacts, artifactClass);
  if (artifact === undefined) {
    return [];
  }
  return artifact.records
    .filter((record) => record.validity !== 'schema_invalid')
    .map((record) => locateRecord<T>(artifact, record));
}

/**
 * One record with where it was read from.
 *
 * @example
 * locateRecord<JournalEvent>(artifact, artifact.records[0]);
 */
export function locateRecord<T>(artifact: IngestedArtifact, record: IngestedRecord): LocatedRecord<T> {
  return {
    record: record.value as unknown as T,
    artifact_path: artifact.path,
    artifact_sha256: artifact.sha256,
    ...(record.line_number === undefined ? {} : { line_number: record.line_number }),
    origin: artifact.origin,
    correlation_missing: record.validity === 'correlation_missing',
  };
}
