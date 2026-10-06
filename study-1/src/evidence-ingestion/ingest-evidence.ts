// Design §8.2: the ingestion pipeline I1-I8 from exact artifact bytes to the typed evidence model
// the oracle, the treatment-fidelity conditions and the probe verdict read. Pure and total: the
// schema validator is injected, nothing is read from disk, and no input bytes make it throw.

import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { readArtifacts } from './artifact-reading.ts';
import { resolveCausation } from './causation-resolution.ts';
import { checkCoreDigests } from './core-digests.ts';
import { indexEvents } from './event-indexing.ts';
import { buildIdentityRegistry } from './identity-registry.ts';
import { mergeFindings, sortFindings } from './ingestion-findings.ts';
import type { IngestedEvidence, IngestionInput } from './ingestion-model.ts';
import { readLedger } from './ledger-view.ts';
import { readObservations } from './observation-view.ts';
import { classifyRecords } from './record-classification.ts';
import { resolveScope } from './scope-resolution.ts';
import { checkSequenceDensity } from './sequence-density.ts';

/**
 * Ingests one trial's or the probe's evidence. Every BR-RUA-034 classification is returned as a
 * finding (merged per artifact and source instance, in a deterministic order) and the typed views
 * keep only usable records.
 *
 * @example
 * const evidence = ingestEvidence(
 *   { artifacts, expected: expectedArtifactsFor(trialManifest), execution_scope_artifacts: [] },
 *   createRecordValidator(),
 * );
 * evidence.findings.map((finding) => finding.code);
 */
export function ingestEvidence(input: IngestionInput, validator: RecordValidator): IngestedEvidence {
  const reading = readArtifacts(input);
  const scope = resolveScope(reading.artifacts, input.expected, input.indexed_digests !== undefined, validator);
  const classified = classifyRecords(reading.artifacts, scope, validator);
  const artifacts = classified.artifacts;
  const collapse = indexEvents(artifacts);
  const indexed = [...collapse.by_id.values()];
  const density = checkSequenceDensity(indexed);
  const causation = resolveCausation(collapse.by_id);
  const ledger = readLedger(artifacts);
  const observations = readObservations(artifacts, input.expected);
  const findings = [
    ...reading.findings,
    ...classified.findings,
    ...checkCoreDigests(artifacts, scope, input.indexed_digests),
    ...collapse.findings,
    ...density.findings,
    ...causation.findings,
    ...ledger.findings,
    ...observations.findings,
  ];
  return {
    scope,
    expected: input.expected,
    artifacts: new Map(artifacts.map((artifact) => [artifact.path, artifact])),
    events: {
      by_id: collapse.by_id,
      subject: indexed.filter((event) => event.origin === 'subject'),
      instances: density.instances,
      conflicting_event_ids: collapse.conflicting_event_ids,
      unresolved_causation: causation.unresolved,
    },
    ledger: ledger.view,
    observations: observations.view,
    identities: buildIdentityRegistry(indexed, artifacts),
    findings: sortFindings(mergeFindings(findings)),
    diagnostics: { collapsed_duplicate_count: collapse.collapsed_duplicate_count },
    ...(input.indexed_digests === undefined ? {} : { indexed_digests: input.indexed_digests }),
  };
}
